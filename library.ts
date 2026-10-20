// The Bunny Stream library as a whole: search videos, see which collection each is in, its stats and watch heatmap,
// move videos between collections, and download one at 1080p as a single MP4.
// API: https://bunny.net/docs/api-reference/stream (List Videos, Get Video, Update Video, Statistics, Heatmap,
// Resolutions). Downloads come from the library's CDN host, so a library with token authentication, "Block direct
// URL file access" or an Allowed domains list refuses them (403).
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** What library.ts needs from a Bunny client: its API call and a fetch for CDN files. */
export type LibraryHost = {
  api(method: string, path: string, body?: object): Promise<any>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  findOrCreateCollection(name: string): Promise<string>;
};
export type LibVideo = {
  id: string; title: string; collectionId: string; views: number; averageWatchTime: number; totalWatchTime: number;
  length: number; storageSize: number; dateUploaded: string; status: number; thumbnailUrl?: string;
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (s: unknown): s is string => typeof s === "string" && GUID.test(s);
const guid = (s: unknown, what = "video id") => {
  if (!isGuid(s)) throw Object.assign(new Error(`not a ${what}`), { status: 400 }); // it goes into an API path
  return s;
};

const pick = (v: any): LibVideo => ({
  id: v.guid, title: v.title, collectionId: v.collectionId ?? "", views: v.views ?? 0, averageWatchTime: v.averageWatchTime ?? 0,
  totalWatchTime: v.totalWatchTime ?? 0, length: v.length ?? 0, storageSize: v.storageSize ?? 0, dateUploaded: v.dateUploaded,
  status: v.status, thumbnailUrl: v.thumbnailUrl,
});

/** Every collection, all pages. */
export async function listCollections(b: LibraryHost) {
  const out: { id: string; name: string; videoCount: number; totalSize: number }[] = [];
  for (let page = 1; ; page++) {
    const r = await b.api("GET", `/collections?${new URLSearchParams({ page: String(page), itemsPerPage: "100", orderBy: "date" })}`);
    out.push(...r.items.map((c: any) => ({ id: c.guid, name: c.name, videoCount: c.videoCount, totalSize: c.totalSize })));
    if (out.length >= r.totalItems || !r.items.length) return out;
  }
}

/** One page of videos. search matches titles only (Bunny's search); collection "" = every video. */
export async function searchVideos(b: LibraryHost, q: { search?: string; collection?: string; page?: number; orderBy?: string }) {
  const params = new URLSearchParams({ page: String(Math.max(1, Math.floor(q.page ?? 1))), itemsPerPage: "50", orderBy: q.orderBy === "title" ? "title" : "date" });
  if (q.search?.trim()) params.set("search", q.search.trim());
  if (q.collection) params.set("collection", guid(q.collection, "collection id"));
  const r = await b.api("GET", `/videos?${params}`);
  return { totalItems: r.totalItems as number, page: r.currentPage as number, perPage: r.itemsPerPage as number, items: (r.items as any[]).map(pick) };
}

const day = (d: Date) => d.toISOString().slice(0, 10);
/** Views and watch time per day and per country over the last `days`, for the library or one video. */
export async function stats(b: LibraryHost, days = 30, videoId?: string) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const params = new URLSearchParams({ dateFrom: day(from), dateTo: day(to), hourly: "false" });
  if (videoId) params.set("videoGuid", guid(videoId));
  const r = await b.api("GET", `/statistics?${params}`);
  const series = (o: Record<string, number> = {}) => Object.entries(o).map(([k, n]) => [k.slice(0, 10), n] as [string, number]).sort();
  const top = (o: Record<string, number> = {}) => Object.entries(o).sort((a, z) => z[1] - a[1]);
  return { views: series(r.viewsChart), watchTime: series(r.watchTimeChart), countries: top(r.countryViewCounts), engagement: r.engagementScore as number };
}

/** A video with its collection, last-30-day stats, watch heatmap and what can be downloaded. */
export async function videoDetails(b: LibraryHost, id: string) {
  guid(id);
  const [video, last30, heat, res] = await Promise.all([
    b.api("GET", `/videos/${id}`),
    stats(b, 30, id),
    b.api("GET", `/videos/${id}/heatmap`).catch(() => ({ heatmap: {} })), // no plays yet: nothing to show
    b.api("GET", `/videos/${id}/resolutions`).catch(() => ({ data: {} })),
  ]);
  const heatmap = Object.entries(heat?.heatmap ?? {}).sort((a, z) => Number(a[0]) - Number(z[0])).map(([, n]) => Number(n));
  const names = (list: { resolution: string }[] = []) => list.map((r) => r.resolution);
  return {
    video: pick(video), stats: last30, heatmap,
    mp4: names(res.data?.mp4Resolutions), hls: names(res.data?.playlistResolutions), hasOriginal: !!res.data?.hasOriginal,
  };
}

/** Put videos in a collection ("" = take them out of any). Bunny's Update Video: an empty string removes it. */
export async function moveVideos(b: LibraryHost, ids: unknown[], collectionId: string) {
  if (collectionId) guid(collectionId, "collection id");
  for (const id of ids) await b.api("POST", `/videos/${guid(id)}`, { collectionId });
  return ids.length;
}

const height = (r: string) => Number(/(\d+)p$/.exec(r)?.[1] ?? /x(\d+)$/.exec(r)?.[1] ?? 0); // "1080p" or legacy "1920x1080"

/** The variant of an HLS master playlist closest to `want` lines without going over (else the smallest above). */
export function pickVariant(master: string, base: string, want = 1080) {
  const variants: { height: number; url: string }[] = [];
  const lines = master.split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /^#EXT-X-STREAM-INF:.*RESOLUTION=\d+x(\d+)/.exec(line);
    const uri = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (m && uri) variants.push({ height: Number(m[1]), url: new URL(uri.trim(), base).href });
  });
  const fits = variants.filter((v) => v.height <= want).sort((a, z) => z.height - a.height);
  return fits[0] ?? variants.sort((a, z) => a.height - z.height)[0] ?? null;
}

const safeName = (title: string, id: string) =>
  (title.replace(/[/\\:*?"<>|\x00-\x1f]+/g, "_").replace(/\.(mp4|mov|m4v|mkv|webm|avi)$/i, "").trim().slice(0, 150) || id);
/** A file name in `dir` that doesn't exist yet. */
function freePath(dir: string, name: string) {
  let path = join(dir, `${name}.mp4`);
  for (let i = 2; existsSync(path) || existsSync(`${path}.part`); i++) path = join(dir, `${name} ${i}.mp4`);
  return path;
}

const refused = (status: number) =>
  new Error(`Bunny refused the download (HTTP ${status}). Token authentication, "Block direct URL file access" or an Allowed domains list is on for this library.`);

/**
 * Save one video as a single MP4 in `dir`, 1080p if it has it (else the best below). Uses the MP4 fallback file when
 * there's one at that height (a plain download), otherwise copies the HLS stream into an MP4 with ffmpeg (no
 * re-encoding). Writes to <file>.part and renames when complete, so a half-done download never looks finished.
 */
export async function download(b: LibraryHost, id: string, dir: string, onProgress: (pct: number) => void = () => {}, opts: { ffmpeg?: string } = {}) {
  const { video, mp4, hls } = await videoDetails(b, id);
  if (!video.thumbnailUrl) throw new Error("Bunny didn't say which CDN host serves this library");
  const cdn = `https://${new URL(video.thumbnailUrl).host}/${id}`;
  const best = (list: string[]) => Math.max(0, ...list.map(height).filter((h) => h <= 1080));
  const [m, h] = [best(mp4), best(hls)];
  if (!m && !h) throw new Error("this video has no MP4 or stream at or below 1080p yet (still encoding?)");
  const path = freePath(dir, safeName(video.title, id));
  const part = `${path}.part`;
  try {
    if (m >= h) { // the MP4 fallback file: a plain download
      const r = await b.fetch(`${cdn}/play_${m}p.mp4`, { method: "GET" });
      if (r.status === 403 || r.status === 401) throw refused(r.status);
      if (!r.ok || !r.body) throw new Error(`downloading play_${m}p.mp4: HTTP ${r.status}`);
      const size = Number(r.headers.get("content-length")) || 0;
      let got = 0;
      const counted = Readable.fromWeb(r.body as any).on("data", (c: Buffer) => size && onProgress(Math.floor(((got += c.length) * 100) / size)));
      await pipeline(counted, createWriteStream(part, { flags: "wx" }));
    } else { // no MP4 at that height: copy the HLS variant into one MP4
      const r = await b.fetch(`${cdn}/playlist.m3u8`, { method: "GET" });
      if (r.status === 403 || r.status === 401) throw refused(r.status);
      if (!r.ok) throw new Error(`reading the stream's playlist: HTTP ${r.status}`);
      const variant = pickVariant(await r.text(), `${cdn}/playlist.m3u8`);
      if (!variant) throw new Error("the stream's playlist lists no video variants");
      await ffmpegCopy(opts.ffmpeg ?? "ffmpeg", variant.url, part, video.length, onProgress);
    }
    renameSync(part, path);
    onProgress(100);
    return { path, height: Math.max(m, h), via: m >= h ? "MP4 file" : "stream (ffmpeg)" };
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
}

/** ffmpeg -c copy: remux, no re-encode. Progress from its -progress output against the video's length. */
function ffmpegCopy(ffmpeg: string, url: string, out: string, seconds: number, onProgress: (pct: number) => void) {
  return new Promise<void>((ok, fail) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", url, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1", out]);
    let err = "";
    p.stdout.on("data", (d: Buffer) => {
      const us = /out_time_us=(\d+)/.exec(String(d))?.[1];
      if (us && seconds) onProgress(Math.min(99, Math.floor(Number(us) / 1e4 / seconds)));
    });
    p.stderr.on("data", (d: Buffer) => (err += d).length > 4000 && (err = err.slice(-4000)));
    p.on("error", (e) => fail(new Error(`couldn't run ffmpeg (${e.message}): install it with brew install ffmpeg`)));
    p.on("close", (code) => (code === 0 ? ok() : fail(new Error(/403|Forbidden/.test(err) ? refused(403).message : `ffmpeg failed: ${err.trim().split("\n").pop()}`))));
  });
}

/** Every video in the library (1000 per page, Bunny's maximum). */
export async function allVideos(b: LibraryHost) {
  const out: LibVideo[] = [];
  for (let page = 1; ; page++) {
    const r = await b.api("GET", `/videos?${new URLSearchParams({ page: String(page), itemsPerPage: "1000", orderBy: "date" })}`);
    out.push(...(r.items as any[]).map(pick));
    if (out.length >= r.totalItems || !r.items.length) return out;
  }
}

/** Run `work` over `items`, `n` at a time. */
async function pool<T, R>(items: T[], n: number, work: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  }));
  return out;
}

/**
 * Which videos are popular over the last `days`, and how that changed: each video's daily views over the last
 * 2 × days (one Statistics call per video, `concurrency` at a time), split into this period and the one before.
 * Ranked by views this period. Collections get the same totals summed.
 */
export async function popularity(b: LibraryHost, days: number, onProgress: (done: number, total: number) => void = () => {}, concurrency = 6) {
  const videos = await allVideos(b);
  const today = new Date();
  const dates = Array.from({ length: 2 * days }, (_, i) => day(new Date(today.getTime() - (2 * days - 1 - i) * 86_400_000)));
  let done = 0;
  const rows = await pool(videos, concurrency, async (v) => {
    const params = new URLSearchParams({ videoGuid: v.id, dateFrom: dates[0], dateTo: dates.at(-1)!, hourly: "false" });
    const chart: Record<string, number> = (await b.api("GET", `/statistics?${params}`)).viewsChart ?? {};
    const byDay = new Map(Object.entries(chart).map(([k, n]) => [k.slice(0, 10), Number(n) || 0]));
    const series = dates.map((d) => byDay.get(d) ?? 0);
    onProgress(++done, videos.length);
    const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
    return { id: v.id, title: v.title, collectionId: v.collectionId, total: v.views, dateUploaded: v.dateUploaded,
      views: sum(series.slice(days)), prev: sum(series.slice(0, days)), daily: series.slice(days) };
  });
  rows.sort((a, z) => z.views - a.views || z.total - a.total);
  const collections = new Map<string, { collectionId: string; videos: number; views: number; prev: number }>();
  for (const r of rows) {
    const c = collections.get(r.collectionId) ?? { collectionId: r.collectionId, videos: 0, views: 0, prev: 0 };
    Object.assign(c, { videos: c.videos + 1, views: c.views + r.views, prev: c.prev + r.prev });
    collections.set(r.collectionId, c);
  }
  return {
    days, from: dates[days], to: dates.at(-1)!, at: new Date().toISOString(), checked: rows.length,
    videos: rows.slice(0, 100), collections: [...collections.values()].sort((a, z) => z.views - a.views),
  };
}
