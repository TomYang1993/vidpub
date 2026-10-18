// vidpub GUI: build a job in a web page and watch it run. Same engine and the same job.json as the CLI, so a
// job started here can be rerun with `node vidpub.ts <folder>/job.json`, and a CLI job can be opened here.
//
// Usage: npm run ui   (serves on 127.0.0.1 only and opens your browser; Ctrl+C stops it, Start again resumes)
//
// Any website you visit can send requests to a server on localhost, so every request needs the per-launch token
// from the opened URL, Host and Origin must be this server's own (blocks DNS rebinding and CSRF), and files are
// only read in folders picked with the native folder dialog.
import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { parseEnv, promisify } from "node:util";
import { Bunny, HttpError, VIDEO_TYPES } from "../bunny.ts";
import { PATREON_PROFILE, PUBLISHERS, TEMPLATES, type PostDoc, type Publisher, type Video } from "../publishers.ts";
import { buildPost, IMAGE_TYPES, loadJob, notify, postPath, publishPost, savePost, uploadVideos, type Host, type Job, type RunEvent } from "../vidpub.ts";

/** A job as the page sends it: names of files in the picked folder instead of paths. */
export type Form = {
  template?: string;
  videos?: string[];
  images?: string[];
  collection?: string;
  post?: { title: string; text?: string; access?: string | string[]; thumbnail?: string; collection?: string; attachments?: string[]; publishNow?: boolean };
  publish?: string[];
};
type Env = Record<string, string | undefined>;
type Row = { name: string; label: string; pct: number | null; status?: number | null };
type Live = {
  dir: string; jobPath: string; step: "upload" | "publish"; running: boolean; error?: string;
  videos: Row[]; publish: { name: string; running: boolean; result?: string }[]; links: Video[]; log: string[];
};

const IMAGE_MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif" };
const DRAFT = ".job.draft.json"; // validated here before it may replace job.json
const OURS = /^job\.json$|\.(state|post)\.json(\.tmp)?$|\.patreon\.txt$|\.patreon-error\.png$/; // outputs, not inputs
const STATUS: Record<string, string> = { // Bunny REST status codes (see bunny.ts); -1 = a status check failed
  "-1": "checking again", null: "missing on Bunny", 0: "waiting for upload", 1: "uploaded", 2: "processing",
  3: "encoding", 4: "ready", 5: "encoding failed, will re-upload", 6: "upload failed, will re-upload", 7: "encoding", 8: "ready",
};

/** Check a job from the page and save it as <dir>/job.json. Lists every problem; a bad job never replaces a saved one. */
export function writeJob(dir: string, form: Form, publishers: Record<string, Publisher> = PUBLISHERS): Job {
  const { post } = form;
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const names = [...list(form.videos), ...list(form.images), post?.thumbnail, ...list(post?.attachments)];
  const outside = names.filter((n) => n !== undefined && (typeof n !== "string" || n !== basename(n) || n === "." || n === ".."));
  if (outside.length) throw new Error(`not files in ${dir}: ${outside.join(", ")}`); // before anything touches the disk

  const raw = {
    template: form.template,
    collection: form.collection?.trim() || undefined,
    videos: form.videos?.length ? form.videos : undefined,
    images: form.images?.length ? form.images : undefined,
    post: post && { ...post, title: typeof post.title === "string" ? post.title.trim() : post.title },
    publish: post ? (form.publish ?? []) : undefined,
  };
  const problems: string[] = [];
  if (post && !raw.publish?.length) problems.push("pick where to publish the post");
  const draft = join(dir, DRAFT);
  try {
    writeFileSync(draft, `${JSON.stringify(raw, null, 2)}\n`);
    try {
      loadJob(draft, publishers);
    } catch (e) {
      const [first, ...found] = (e as Error).message.split("\n  ");
      problems.push(...(found.length ? found : [first]));
    }
    if (problems.length) throw new Error(problems.join("\n"));
    renameSync(draft, join(dir, "job.json"));
  } finally {
    rmSync(draft, { force: true });
  }
  return loadJob(join(dir, "job.json"), publishers);
}

/** The page's edits to a saved post. Only the title and the wording of existing text blocks can change, so the page
 *  can't slip in an image path (a publisher would upload that file). Emptied text blocks are dropped. */
export function applyEdits(doc: PostDoc, edits: { title?: unknown; texts?: unknown }): PostDoc {
  const texts = Array.isArray(edits.texts) ? edits.texts : [];
  let i = 0;
  const blocks = doc.blocks
    .map((b) => {
      if (!("text" in b)) return b;
      const t = texts[i++];
      return typeof t === "string" ? { text: t.trim() } : b;
    })
    .filter((b) => !("text" in b) || b.text);
  return { ...doc, title: typeof edits.title === "string" && edits.title.trim() ? edits.title.trim() : doc.title, blocks };
}

/** The folder's files for the page, plus its job.json (if any) translated back into a Form. */
export function listFolder(dir: string) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((f) => f.isFile() && !f.name.startsWith(".") && !OURS.test(f.name)) // isFile: symlinks out of the folder don't count
    .map((f) => {
      const ext = extname(f.name).toLowerCase();
      return { name: f.name, size: statSync(join(dir, f.name)).size, kind: Object.hasOwn(VIDEO_TYPES, ext) ? "video" : IMAGE_TYPES.has(ext) ? "image" : "other" };
    });
  let job: Form | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
    const here = (p: unknown) => // a job path that points at a file in this folder -> its name
      typeof p === "string" && resolve(dir, p.replace(/^~(?=\/)/, homedir())) === join(dir, basename(p)) ? basename(p) : undefined;
    job = {
      ...raw,
      videos: (raw.videos ?? []).map(here).filter(Boolean),
      images: (raw.images ?? []).map(here).filter(Boolean),
      post: raw.post && { ...raw.post, thumbnail: here(raw.post.thumbnail), attachments: (raw.post.attachments ?? []).map(here).filter(Boolean) },
    };
  } catch {} // no job.json yet, or not one we can read: start blank
  return { dir, files, job };
}

async function osascriptFolder(): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)("osascript", ["-e", "activate", "-e", 'POSIX path of (choose folder with prompt "Pick the folder with your videos")']);
    return stdout.trim();
  } catch (e) {
    if (/-128/.test(String((e as { stderr?: string }).stderr))) return null; // Cancel
    throw e;
  }
}

export function serve(opts: {
  publishers?: Record<string, Publisher>;
  makeHost?: (env: Env, onUpload: (path: string, sent: number, size: number) => void) => Host;
  chooseFolder?: () => Promise<string | null>;
  recentFile?: string; // folders picked so far: the only places this server reads
  envFile?: string;
} = {}): Promise<{ server: Server; url: string }> {
  const {
    publishers = PUBLISHERS,
    makeHost = (env, onUpload) => new Bunny(env.BUNNY_LIBRARY_ID!, env.BUNNY_API_KEY!, { onUpload }),
    chooseFolder = osascriptFolder,
    recentFile = join(homedir(), ".vidpub", "ui.json"),
    envFile = join(import.meta.dirname, "..", ".env"),
  } = opts;
  const token = Buffer.from(randomBytes(32).toString("base64url"));
  let recent: string[] = existsSync(recentFile) ? JSON.parse(readFileSync(recentFile, "utf8")).folders : [];
  let live: Live | null = null;
  const clients = new Set<ServerResponse>();

  const readEnv = (): Env => ({ ...process.env, ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {}) });
  const fail = (status: number, msg: string) => Object.assign(new Error(msg), { status });
  const push = () => {
    for (const c of clients) c.write(`data: ${JSON.stringify(live)}\n\n`);
  };

  function picked(dir: unknown) {
    const real = typeof dir === "string" && existsSync(dir) ? realpathSync(dir) : "";
    if (!real || !recent.some((r) => real === r || real.startsWith(r + sep))) throw fail(403, "pick that folder with Choose folder first");
    return real;
  }
  function remember(dir: string) {
    recent = [dir, ...recent.filter((d) => d !== dir)].slice(0, 20);
    mkdirSync(dirname(recentFile), { recursive: true });
    writeFileSync(recentFile, `${JSON.stringify({ folders: recent }, null, 2)}\n`);
  }

  function jobs() {
    const read = (p: string) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
    return recent.filter((d) => existsSync(d)).flatMap((dir) => {
      const names = readdirSync(dir); // a job.json (GUI jobs, even before anything ran) or a CLI run's state file
      const states = names.filter((f) => f.endsWith(".state.json")).map((f) => join(dir, f.slice(0, -".state.json".length)));
      return [...new Set([...(names.includes("job.json") ? [join(dir, "job.json")] : []), ...states])].map((jobPath) => {
        const state = read(`${jobPath}.state.json`) ?? {};
        const raw = extname(jobPath) === ".json" ? read(jobPath) ?? {} : { videos: [jobPath] }; // CLI single-video run
        const paths: string[] = (raw.videos ?? []).map((p: string) => resolve(dir, p.replace(/^~(?=\/)/, homedir())));
        const mine = live?.jobPath === jobPath ? live : null;
        return {
          dir, job: basename(jobPath), mtime: statSync(existsSync(`${jobPath}.state.json`) ? `${jobPath}.state.json` : jobPath).mtimeMs,
          videos: paths.length, uploaded: paths.filter((p) => state.videos?.[p]?.guid).length, images: raw.images?.length ?? 0,
          publish: raw.publish ?? [], published: state.published ?? {}, built: existsSync(`${jobPath}.post.json`),
          running: !!mine?.running, error: mine?.error,
        };
      });
    }).sort((a, b) => b.mtime - a.mtime);
  }

  /** A fresh `live` for one step on a job, rows and earlier publisher results filled in from its state. */
  function begin(dir: string, job: Job, step: Live["step"]): Live {
    const statePath = `${job.path}.state.json`;
    const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { videos: {}, published: {} };
    live = {
      dir, jobPath: job.path, step, running: true, links: [], log: [],
      videos: step === "upload" ? job.videos.map((v) => ({ name: basename(v), label: prev.videos[v]?.guid ? "on Bunny from a past run" : "queued", pct: null })) : [],
      publish: job.publish.map((name) => ({ name, running: false, result: prev.published[name] })),
    };
    push();
    return live;
  }

  /** Engine progress -> `live`. */
  function track(cur: Live, job: Job) {
    const row = (path: string) => cur.videos[job.videos.indexOf(path)];
    const onEvent = (e: RunEvent) => {
      if (e.type === "upload") {
        Object.assign(row(e.video), { pct: 0, status: undefined, label: !e.fresh ? "resuming upload" : e.attempt > 1 ? `re-uploading (try ${e.attempt})` : "uploading" });
      } else if (e.type === "encoding") {
        for (const [v, s] of Object.entries(e.statuses)) Object.assign(row(v), { status: s, label: STATUS[String(s)] ?? `Bunny status ${s}` });
      } else if (e.type === "ready") {
        cur.links = e.videos;
      } else {
        Object.assign(cur.publish.find((p) => p.name === e.name)!, { running: !e.result, result: e.result });
      }
      push();
    };
    const onUpload = (path: string, sent: number, size: number) => {
      Object.assign(row(path), { pct: Math.floor((sent * 100) / size), ...(sent === size && { label: "uploaded" }) });
      push();
    };
    return { onEvent, onUpload };
  }

  /** Run a step in the background: the request returns now, progress goes out over /events. */
  function background(cur: Live, work: () => Promise<string>) {
    // ponytail: mirror the engine's console into the page's log instead of threading a logger through it.
    // Global, so fine for one step at a time (callers refuse a second one).
    const log = console.log;
    console.log = (...a: unknown[]) => {
      log(...a);
      cur.log = [...cur.log.slice(-299), a.join(" ")];
      push();
    };
    work()
      .then((done) => notify(`${basename(cur.dir)}: ${done}`), (e: Error) => {
        cur.error = e.message;
        notify(`${basename(cur.dir)} failed: ${e.message}`);
      })
      .finally(() => {
        console.log = log;
        cur.running = false;
        push();
      });
  }

  /** Step 1: save job.json, upload the videos (if any) and build <job>.post.json for review. Nothing is published. */
  function start(dir: string, form: Form, rebuild: boolean) {
    if (live?.running) throw fail(409, "something is already running");
    const job = writeJob(dir, form, publishers);
    const env = readEnv();
    if (job.videos.length && (!env.BUNNY_LIBRARY_ID || !env.BUNNY_API_KEY)) {
      throw fail(400, "Saved job.json. Add your Bunny library ID and API key in Settings, then Start.");
    }
    const cur = begin(dir, job, "upload");
    const { onEvent, onUpload } = track(cur, job);
    background(cur, async () => {
      const videos = job.videos.length ? await uploadVideos(job, makeHost(env, onUpload), undefined, onEvent) : [];
      if (!job.post) return "videos are ready";
      if (rebuild) rmSync(postPath(job), { force: true }); // the page asked to drop hand edits the job no longer matches
      buildPost(job, videos);
      return "the post is ready to review";
    });
  }

  /** Step 2: send <job>.post.json, exactly as saved, to the job's publishers. */
  function publish(dir: string) {
    if (live?.running) throw fail(409, "something is already running");
    const job = loadJob(join(dir, "job.json"), publishers);
    if (!existsSync(postPath(job))) throw fail(400, "no post yet: press Start first");
    if (job.publish.includes("patreon_browser") && publishers === PUBLISHERS && !existsSync(PATREON_PROFILE)) {
      throw fail(400, "Log in to Patreon once first: run node patreon-login.ts in the vidpub folder, then send again.");
    }
    const cur = begin(dir, job, "publish");
    background(cur, async () => {
      await publishPost(job, publishers, track(cur, job).onEvent);
      return "post sent";
    });
  }

  /** The saved post for the preview, with what each publisher already did. */
  function readPost(dir: string) {
    const job = loadJob(join(dir, "job.json"), publishers);
    if (!existsSync(postPath(job))) return { doc: null };
    const state = existsSync(`${job.path}.state.json`) ? JSON.parse(readFileSync(`${job.path}.state.json`, "utf8")) : {};
    // ponytail: reads the engine's DocFile ({ inputs, built, doc }) directly; a readPost export would hide that
    const { doc } = JSON.parse(readFileSync(postPath(job), "utf8")) as { doc: PostDoc };
    return { doc, publish: job.publish, published: state.published ?? {}, job };
  }

  async function settings(body: { libraryId?: unknown; apiKey?: unknown }) {
    const lib = String(body.libraryId ?? "").trim();
    const key = String(body.apiKey ?? "").trim();
    if (!/^\d+$/.test(lib)) throw fail(400, "the library ID is a number (Bunny → Stream → your library → API)");
    if (key && !/^[\w-]+$/.test(key)) throw fail(400, "that doesn't look like a Bunny API key");
    let text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    for (const [k, v] of Object.entries({ BUNNY_LIBRARY_ID: lib, ...(key && { BUNNY_API_KEY: key }) })) {
      const re = new RegExp(`^${k}=.*$`, "m");
      text = re.test(text) ? text.replace(re, () => `${k}=${v}`) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${k}=${v}\n`;
    }
    writeFileSync(envFile, text, { mode: 0o600 });
    const env = readEnv();
    if (!env.BUNNY_API_KEY) return { check: "Saved. Now add the API key." };
    try {
      await new Bunny(lib, env.BUNNY_API_KEY).api("GET", "/collections?itemsPerPage=1");
      return { check: "Saved. Bunny accepted the key." };
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) return { check: "Saved, but Bunny refused the key. Check that it's this library's key, not the account key." };
      return { check: `Saved, but couldn't check it with Bunny: ${(e as Error).message}` };
    }
  }

  async function body(req: IncomingMessage) {
    let s = "";
    for await (const chunk of req) if ((s += chunk).length > 1e6) throw fail(413, "request too big");
    return s ? JSON.parse(s) : {};
  }
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(data));
  };

  const server = createServer(async (req, res) => {
    const self = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? "/", `http://${self}`);
    const given = Buffer.from(String(req.headers["x-vidpub-token"] ?? url.searchParams.get("t") ?? ""));
    const site = req.headers["sec-fetch-site"];
    const trusted = req.headers.host === self // DNS rebinding: evil.com resolving to 127.0.0.1 still sends Host: evil.com
      && (req.headers.origin === undefined ? req.method === "GET" : req.headers.origin === `http://${self}`) // CSRF
      && (!site || site === "same-origin" || site === "none")
      && given.length === token.length && timingSafeEqual(given, token);
    try {
      if (!trusted) throw fail(403, "forbidden");
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer", // the token is in this page's URL; links out must not carry it
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        }).end(readFileSync(join(import.meta.dirname, "index.html")));
      } else if (route === "GET /events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(`data: ${JSON.stringify(live)}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
      } else if (route === "GET /api/session") {
        const env = readEnv();
        const templates = Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, needs: t.needs }));
        json(res, 200, { folders: recent, templates, libraryId: env.BUNNY_LIBRARY_ID ?? "", hasKey: !!env.BUNNY_API_KEY });
      } else if (route === "GET /api/jobs") {
        json(res, 200, { jobs: jobs() });
      } else if (route === "POST /api/pick") {
        const dir = await chooseFolder();
        if (!dir) return json(res, 200, { cancelled: true });
        remember(realpathSync(dir));
        json(res, 200, listFolder(realpathSync(dir)));
      } else if (route === "POST /api/folder") {
        json(res, 200, listFolder(picked((await body(req)).dir)));
      } else if (route === "POST /api/start") {
        const { dir, form, rebuild } = await body(req);
        start(picked(dir), form, rebuild === true);
        json(res, 200, { ok: true });
      } else if (route === "POST /api/post") {
        const { job, ...post } = readPost(picked((await body(req)).dir));
        json(res, 200, post);
      } else if (route === "POST /api/post/save") {
        const edits = await body(req);
        const { doc, job } = readPost(picked(edits.dir));
        if (!doc || !job) throw fail(400, "no post yet: press Start first");
        savePost(job, applyEdits(doc, edits));
        json(res, 200, { ok: true });
      } else if (route === "POST /api/publish") {
        publish(picked((await body(req)).dir));
        json(res, 200, { ok: true });
      } else if (route === "GET /file") { // preview images that are files (an image gallery's), only from picked folders
        const p = url.searchParams.get("p") ?? "";
        const file = join(picked(dirname(p)), basename(p));
        const type = IMAGE_MIME[extname(file).toLowerCase()];
        if (!type || !existsSync(file) || !lstatSync(file).isFile()) throw fail(404, "not found"); // lstat: no symlinks out
        res.writeHead(200, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store" }).end(readFileSync(file));
      } else if (route === "POST /api/settings") {
        json(res, 200, await settings(await body(req)));
      } else {
        throw fail(404, "not found");
      }
    } catch (e) {
      if (!res.headersSent) json(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message });
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => {
    ok({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/?t=${token}` });
  }));
}

if (process.argv[1] === import.meta.filename) {
  const { url } = await serve();
  console.log(`vidpub GUI: ${url}\n(only this URL works; Ctrl+C to stop)`);
  spawn("open", [url], { stdio: "ignore" });
}
