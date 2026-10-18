// Bunny Stream client: collections, videos, resumable (TUS) uploads.
// API: https://docs.bunny.net/reference/video_createvideo
// TUS: https://docs.bunny.net/stream/tus-resumable-uploads
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const API = "https://video.bunnycdn.com";
const TUS_ENDPOINT = `${API}/tusupload`;
const TUS_TTL = 24 * 3600; // signature lifetime (s); an unfinished upload expires with it
export const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
};

// Video `status` from the REST API (webhooks use a different numbering).
export const READY = new Set([4, 8]); // Finished, JitPlaylistsCreated (JIT libraries play from here)
export const FAILED = new Set([5, 6]); // Error, UploadFailed

export class HttpError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.status = status;
  }
}

export function tusSignature(libraryId: string, apiKey: string, expire: number, videoId: string) {
  return createHash("sha256").update(`${libraryId}${apiKey}${expire}${videoId}`).digest("hex");
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<unknown>;

export class Bunny {
  lib: string;
  key: string;
  fetch: Fetch;
  sleep: Sleep;
  chunk: number;
  onUpload?: (path: string, sent: number, size: number) => void; // progress, after every chunk

  constructor(libraryId: string | number, apiKey: string, opts: { fetch?: Fetch; sleep?: Sleep; chunk?: number; onUpload?: Bunny["onUpload"] } = {}) {
    this.lib = String(libraryId);
    this.key = apiKey;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? delay;
    this.chunk = opts.chunk ?? 64 * 1024 * 1024; // bytes per PATCH = most a dropped connection can cost
    this.onUpload = opts.onUpload;
  }

  // GET/DELETE retry on network errors, 429 and 5xx. POST isn't idempotent, so callers handle that.
  async api(method: string, path: string, body?: object): Promise<any> {
    const retries = method === "POST" ? 0 : 5;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await this.fetch(`${API}/library/${this.lib}${path}`, {
          method,
          headers: { AccessKey: this.key, ...(body && { "Content-Type": "application/json" }) },
          body: body && JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await r.text();
        if (!r.ok) throw new HttpError(r.status, text);
        return text ? JSON.parse(text) : null;
      } catch (e) {
        const retryable = !(e instanceof HttpError) || RETRY_STATUS.has(e.status);
        if (!retryable || attempt >= retries) throw e;
        await this.sleep(2 ** attempt * 2000);
      }
    }
  }

  async findOrCreateCollection(name: string): Promise<string> {
    const page = await this.api("GET", `/collections?${new URLSearchParams({ search: name, itemsPerPage: "100" })}`);
    const found = page.items.find((c: { name: string }) => c.name === name);
    return found ? found.guid : (await this.api("POST", "/collections", { name })).guid;
  }

  async createVideo(title: string, collectionId?: string): Promise<string> {
    return (await this.api("POST", "/videos", { title, collectionId })).guid;
  }

  /** REST status code, or null if the video is gone. */
  async status(videoId: string): Promise<number | null> {
    try {
      return (await this.api("GET", `/videos/${videoId}`)).status;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async deleteVideo(videoId: string): Promise<void> {
    try {
      await this.api("DELETE", `/videos/${videoId}`);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
    }
  }

  /** Animated preview ("Preview Animation URL (WebP)"); its CDN host comes from the video's thumbnailUrl. */
  async previewUrl(videoId: string): Promise<string> {
    return new URL("preview.webp", (await this.api("GET", `/videos/${videoId}`)).thumbnailUrl).href;
  }

  playUrl(videoId: string) {
    return `https://player.mediadelivery.net/play/${this.lib}/${videoId}`;
  }

  tusHeaders(videoId: string): Record<string, string> {
    const expire = Math.floor(Date.now() / 1000) + TUS_TTL;
    return {
      AuthorizationSignature: tusSignature(this.lib, this.key, expire, videoId),
      AuthorizationExpire: String(expire),
      LibraryId: this.lib,
      VideoId: videoId,
      "Tus-Resumable": "1.0.0",
    };
  }

  /** Open a resumable upload for an existing video. Returns its URL; keep it to resume later. */
  async tusCreate(path: string, videoId: string, title: string, collectionId?: string): Promise<string> {
    const meta = { filetype: VIDEO_TYPES[extname(path).toLowerCase()] ?? "video/mp4", title, collection: collectionId };
    const r = await this.fetch(TUS_ENDPOINT, {
      method: "POST",
      headers: {
        ...this.tusHeaders(videoId),
        "Upload-Length": String((await stat(path)).size),
        "Upload-Metadata": Object.entries(meta)
          .flatMap(([k, v]) => (v ? [`${k} ${Buffer.from(v).toString("base64")}`] : []))
          .join(","),
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new HttpError(r.status, await r.text());
    const location = r.headers.get("location");
    if (!location) throw new Error("TUS create: no Location header");
    return new URL(location, TUS_ENDPOINT).href;
  }

  /** Send the file, resuming from wherever the server is. False if the upload expired on Bunny's side. */
  async tusUpload(path: string, videoId: string, url: string): Promise<boolean> {
    const name = basename(path);
    const file = await open(path);
    try {
      const { size } = await file.stat();
      const buf = Buffer.allocUnsafe(Math.min(this.chunk, size));
      let offset: number | null = null; // null = unknown: ask the server
      let fails = 0;
      while (offset !== size) {
        try {
          if (offset === null) {
            const r = await this.fetch(url, { method: "HEAD", headers: this.tusHeaders(videoId), signal: AbortSignal.timeout(60_000) });
            if (!r.ok) throw new HttpError(r.status, "");
            offset = uploadOffset(r);
            continue;
          }
          const { bytesRead } = await file.read(buf, 0, Math.min(this.chunk, size - offset), offset);
          const r = await this.fetch(url, {
            method: "PATCH",
            headers: { ...this.tusHeaders(videoId), "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
            body: buf.subarray(0, bytesRead),
            signal: AbortSignal.timeout(30 * 60_000),
          });
          if (!r.ok) throw new HttpError(r.status, await r.text());
          offset = uploadOffset(r);
          fails = 0;
          console.log(`  ${name}: ${Math.floor((offset * 100) / size)}%`);
          this.onUpload?.(path, offset, size);
        } catch (e) {
          const code = e instanceof HttpError ? e.status : null;
          if (code === 404 || code === 410) return false;
          if (code && code < 500 && ![409, 423, 429].includes(code)) throw e; // other 4xx won't fix itself
          if (++fails > 8) throw e;
          console.log(`  ${name}: ${(e as Error).message}; retry ${fails}/8`);
          await this.sleep(Math.min(2 ** fails, 300) * 1000);
          offset = null;
        }
      }
      return true;
    } finally {
      await file.close();
    }
  }
}

function uploadOffset(r: Response) {
  const v = r.headers.get("upload-offset");
  if (v === null) throw new Error("TUS: response missing Upload-Offset"); // retried like a network error
  return Number(v);
}
