// vidpub GUI: build a job in a web page and watch it run. Same engine and the same job.json as the CLI, so a
// job started here can be rerun with `node vidpub.ts <folder>/job.json`, and a CLI job can be opened here.
//
// Usage: npm run ui   (serves on 127.0.0.1 only and opens your browser; Ctrl+C stops it, Start again resumes)
//
// Any website you visit can send requests to a server on localhost, so every request needs the per-launch token
// from the opened URL, Host and Origin must be this server's own (blocks DNS rebinding and CSRF), and files are
// only read in folders picked with the native folder dialog.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { parseEnv, promisify } from "node:util";
import { Bunny, HttpError, VIDEO_TYPES } from "../bunny.ts";
import { PATREON_PROFILE, PUBLISHERS, readPatreonCache, readPatreonOptions, type PatreonOptions, type PostDoc, type Publisher, type Video } from "../publishers.ts";
import { deleteTemplate, loadTemplates, saveTemplate } from "../templates.ts";
import { buildPost, IMAGE_TYPES, loadJob, notify, postPath, publishPost, uploadVideos, type Host, type Job, type RunEvent } from "../vidpub.ts";

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
/** One job in the queue. step "upload" = upload the videos and build the post, then (if it has a post) the same entry
 *  moves to step "publish" = send it; a retried send starts at "publish". */
type Live = {
  id: number; dir: string; jobPath: string; step: "upload" | "publish"; state: "queued" | "running" | "done" | "failed";
  added: number; result?: string; error?: string;
  videos: Row[]; publish: { name: string; running: boolean; result?: string }[]; links: Video[]; log: string[];
};
const FINISHED_KEPT = 20; // finished steps the Jobs tab still shows

// The engine logs with console.log. Each queued step runs inside stepLog with its own sink, so its lines land in that
// step's log even when an upload and a send run at the same time. Outside a step, console.log is unchanged.
const stepLog = new AsyncLocalStorage<(line: string) => void>();
const consoleLog = console.log;
console.log = (...a: unknown[]) => {
  consoleLog(...a);
  stepLog.getStore()?.(a.join(" "));
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
    rmSync(draft, { force: true }); // a symlink planted here would otherwise be written through
    writeFileSync(draft, `${JSON.stringify(raw, null, 2)}\n`, { flag: "wx" });
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

/** Why a post can't be sent from `dir`: a malformed post file, or local files it would upload or read that aren't
 *  inside `dir` once symlinks are resolved. The GUI only ever writes in-folder names, but a job.json or post file
 *  that came with a downloaded folder could point anywhere. loadJob already types the job; the post file is raw JSON. */
export function postProblems(dir: string, job: Job, doc: PostDoc): string[] {
  const str = (x: unknown): x is string => typeof x === "string";
  const shaped = Array.isArray(doc.blocks) && (doc.thumbnail === undefined || str(doc.thumbnail))
    && (doc.attachments === undefined || (Array.isArray(doc.attachments) && doc.attachments.every(str)))
    && doc.blocks.every((b: any) => !!b && typeof b === "object" && Object.keys(b).length === 1
      && ("paywall" in b || "divider" in b ? Object.values(b)[0] === true
        : "button" in b ? !!b.button && str(b.button.text) && str(b.button.url) && /^https:\/\//.test(b.button.url)
          && (b.button.caption === undefined || str(b.button.caption)) && Object.keys(b.button).every((k) => ["text", "url", "caption"].includes(k))
        : Object.values(b).every(str)));
  if (!shaped) return ["the post file is malformed: rebuild it"]; // e.g. attachments: "/etc/hosts" would pass a per-entry check
  const local = (p?: string) => (str(p) && !/^https?:\/\//.test(p) ? [p] : []);
  return [
    ...job.videos, ...job.images, ...local(job.post?.thumbnail), ...(job.post?.attachments ?? []),
    ...local(doc.thumbnail), ...(doc.attachments ?? []), ...doc.blocks.flatMap((b) => ("image" in b ? local(b.image) : [])),
  ].flatMap((p) => {
    try {
      return realpathSync(p).startsWith(dir + sep) ? [] : [`outside ${dir}: ${p}`];
    } catch {
      return [`missing: ${p}`]; // incl. a dangling symlink, which could be pointed anywhere later
    }
  });
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
  readPatreon?: () => Promise<PatreonOptions>; // opens Chrome on the Patreon editor
  patreonCache?: () => PatreonOptions | null;
} = {}): Promise<{ server: Server; url: string }> {
  const {
    publishers = PUBLISHERS,
    makeHost = (env, onUpload) => new Bunny(env.BUNNY_LIBRARY_ID!, env.BUNNY_API_KEY!, { onUpload }),
    chooseFolder = osascriptFolder,
    recentFile = join(homedir(), ".vidpub", "ui.json"),
    envFile = join(import.meta.dirname, "..", ".env"),
    readPatreon = readPatreonOptions,
    patreonCache = () => readPatreonCache(),
  } = opts;
  let readingPatreon = false;
  // read once, like the server's own code: a page edited while the server runs would otherwise talk to old code
  const page = readFileSync(join(import.meta.dirname, "index.html"));
  const token = Buffer.from(randomBytes(32).toString("base64url"));
  let recent: string[] = existsSync(recentFile) ? JSON.parse(readFileSync(recentFile, "utf8")).folders : [];
  // Two lanes, each one step at a time: uploads (they share the uplink anyway) and sends (the Patreon profile can only
  // be open in one Chrome). The lanes run side by side, so a 15 s send doesn't wait behind an hours-long upload.
  let queue: Live[] = [];
  let nextId = 1;
  const laneOf = (q: Live) => (q.step === "upload" ? "upload" : "send");
  const busy = { upload: false, send: false };
  type Phases = { upload?: () => Promise<string>; publish?: () => Promise<string> };
  const works = new Map<number, Phases>();
  const clients = new Set<ServerResponse>();

  const readEnv = (): Env => ({ ...process.env, ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {}) });
  const fail = (status: number, msg: string) => Object.assign(new Error(msg), { status });
  const push = () => {
    for (const c of clients) c.write(`data: ${JSON.stringify({ queue })}\n\n`);
  };

  /** The job's queued or running step, if any: a job is never in the queue twice. */
  const active = (jobPath: string) => queue.find((q) => q.jobPath === jobPath && (q.state === "queued" || q.state === "running"));
  const busyWith = (jobPath: string) => {
    if (active(jobPath)) throw fail(409, `${basename(dirname(jobPath))} is already queued or running: see Jobs`);
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
        const mine = queue.findLast((q) => q.jobPath === jobPath);
        return {
          dir, job: basename(jobPath), mtime: statSync(existsSync(`${jobPath}.state.json`) ? `${jobPath}.state.json` : jobPath).mtimeMs,
          videos: paths.length, uploaded: paths.filter((p) => state.videos?.[p]?.guid).length, images: raw.images?.length ?? 0,
          publish: raw.publish ?? [], published: state.published ?? {}, built: existsSync(`${jobPath}.post.json`),
          queued: mine?.state === "queued", running: mine?.state === "running", error: mine?.state === "failed" ? mine.error : undefined,
        };
      });
    }).sort((a, b) => b.mtime - a.mtime);
  }

  /** A queue entry for one step on a job, rows and earlier publisher results filled in from its state. */
  function begin(dir: string, job: Job, step: Live["step"]): Live {
    const statePath = `${job.path}.state.json`;
    const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { videos: {}, published: {} };
    return {
      id: nextId++, dir, jobPath: job.path, step, state: "queued", added: Date.now(), links: [], log: [],
      videos: step === "upload" ? job.videos.map((v) => ({ name: basename(v), label: prev.videos[v]?.guid ? "on Bunny from a past run" : "waiting", pct: null })) : [],
      publish: job.publish.map((name) => ({ name, running: false, result: prev.published[name] })),
    };
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

  /** Queue a job: the request returns now, the lanes run its phases in turn, progress goes out over /events. */
  function enqueue(cur: Live, phases: Phases) {
    queue.push(cur);
    works.set(cur.id, phases);
    push();
    pump();
  }

  /** Start the next queued step in each lane that's free. */
  function pump() {
    for (const lane of ["upload", "send"] as const) {
      if (busy[lane]) continue;
      const cur = queue.find((q) => q.state === "queued" && laneOf(q) === lane);
      if (!cur) continue;
      if (lane === "send" && readingPatreon) { // Chrome is reading tiers: try again in a second
        setTimeout(pump, 1000);
        continue;
      }
      run(cur, lane);
    }
  }

  function run(cur: Live, lane: keyof typeof busy) {
    busy[lane] = true;
    cur.state = "running";
    push();
    const sink = (line: string) => {
      cur.log = [...cur.log.slice(-299), line];
      push();
    };
    const phases = works.get(cur.id)!;
    stepLog.run(sink, () => phases[cur.step]!())
      .then((done) => {
        if (cur.step === "upload" && phases.publish) { // built: on to the send lane, same entry
          Object.assign(cur, { step: "publish", state: "queued", result: done });
          return;
        }
        Object.assign(cur, { state: "done", result: done });
        notify(`${basename(cur.dir)}: ${done}`);
      }, (e: Error) => {
        Object.assign(cur, { state: "failed", error: e.message });
        notify(`${basename(cur.dir)} failed: ${e.message}`);
      })
      .finally(() => {
        if (cur.state !== "queued") works.delete(cur.id);
        busy[lane] = false;
        const finished = queue.filter((q) => q.state === "done" || q.state === "failed");
        const drop = new Set(finished.slice(0, Math.max(0, finished.length - FINISHED_KEPT)));
        queue = queue.filter((q) => !drop.has(q));
        push();
        pump();
      });
  }

  /** Queue a job: save job.json (form = null: keep the saved one), upload the videos, build <job>.post.json, then
   *  send it to the job's publishers (a Patreon draft, or published if post.publishNow). */
  function start(dir: string, form: Form | null, rebuild: boolean) {
    busyWith(join(dir, "job.json")); // before writing: a queued job's job.json must not change under it
    const job = form ? writeJob(dir, form, publishers) : loadJob(join(dir, "job.json"), publishers);
    if (!form) { // the saved job.json may have come with a downloaded folder: only upload files that are in it
      const problems = postProblems(dir, job, { title: "", access: "", blocks: [] });
      if (problems.length) throw fail(400, `Not starting:\n${problems.join("\n")}`);
    }
    const env = readEnv();
    if (job.videos.length && (!env.BUNNY_LIBRARY_ID || !env.BUNNY_API_KEY)) {
      throw fail(400, "Saved job.json. Add your Bunny library ID and API key in Settings, then Start.");
    }
    needLogin(job); // now, not after hours of uploading
    const cur = begin(dir, job, "upload");
    const { onEvent, onUpload } = track(cur, job);
    enqueue(cur, {
      upload: async () => {
        const videos = job.videos.length ? await uploadVideos(job, makeHost(readEnv(), onUpload), undefined, onEvent) : [];
        if (!job.post) return "videos are ready";
        if (rebuild) rmSync(postPath(job), { force: true }); // drop hand edits the job no longer matches
        buildPost(job, videos);
        return "post built";
      },
      publish: job.post && job.publish.length ? send(dir, cur) : undefined,
    });
  }

  /** Send a built post again (after a failed send). */
  function publish(dir: string) {
    busyWith(join(dir, "job.json"));
    const { job, doc } = readPost(dir);
    if (!job || !doc) throw fail(400, "no post yet: press Start first");
    const problems = postProblems(dir, job, doc);
    if (problems.length) throw fail(400, `Not sending:\n${problems.join("\n")}`);
    needLogin(job);
    const cur = begin(dir, job, "publish");
    enqueue(cur, { publish: send(dir, cur) });
  }

  function needLogin(job: Job) {
    if (job.publish.includes("patreon_browser") && publishers === PUBLISHERS && !existsSync(PATREON_PROFILE)) {
      throw fail(400, "Log in to Patreon once first: run node patreon-login.ts in the vidpub folder, then Start again.");
    }
  }

  /** The send phase: <job>.post.json, exactly as saved, to the job's publishers. Returns their links. */
  const send = (dir: string, cur: Live) => async () => {
    // checked again now: the files may have changed while this waited in the queue
    const now = readPost(dir);
    if (!now.job || !now.doc) throw new Error("the post file is gone: press Start again");
    const later = postProblems(dir, now.job, now.doc);
    if (later.length) throw new Error(`Not sending:\n${later.join("\n")}`);
    await publishPost(now.job, publishers, track(cur, now.job).onEvent);
    return Object.values(readPost(dir).published ?? {}).join(" ");
  };

  /** The job's saved post, with what each publisher already did. */
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
  async function bytes(req: IncomingMessage, max: number) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      if ((size += chunk.length) > max) throw fail(413, `too big: ${Math.round(max / 1e6)} MB at most`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
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
        }).end(page);
      } else if (route === "GET /events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(`data: ${JSON.stringify({ queue })}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
      } else if (route === "GET /api/session") {
        const env = readEnv();
        const { draft, ...patreon } = patreonCache() ?? { tiers: [], collections: [], read: "" };
        json(res, 200, { folders: recent, templates: Object.values(loadTemplates()), patreon, libraryId: env.BUNNY_LIBRARY_ID ?? "", hasKey: !!env.BUNNY_API_KEY });
      } else if (route === "POST /api/templates/save") {
        const t = saveTemplate((await body(req)).template);
        json(res, 200, { id: t.id, templates: Object.values(loadTemplates()) });
      } else if (route === "POST /api/templates/delete") {
        deleteTemplate(String((await body(req)).id));
        json(res, 200, { templates: Object.values(loadTemplates()) });
      } else if (route === "POST /api/patreon/refresh") {
        // one Chrome on the Patreon profile at a time: it's locked while open
        if (readingPatreon || queue.some((q) => q.state === "running" && q.step === "publish")) throw fail(409, "Chrome is busy with Patreon: try again when it's done");
        readingPatreon = true;
        try {
          const { draft, ...patreon } = await readPatreon();
          json(res, 200, patreon);
        } finally {
          readingPatreon = false;
        }
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
        start(picked(dir), form ?? null, rebuild === true);
        json(res, 200, { ok: true });
      } else if (route === "POST /api/cancel") { // only a step that hasn't started: a running one stops with Ctrl+C
        const id = (await body(req)).id;
        const cur = queue.find((q) => q.id === id);
        if (cur?.state !== "queued") throw fail(409, "only a queued step can be cancelled");
        queue = queue.filter((q) => q !== cur);
        works.delete(cur.id);
        push();
        json(res, 200, { ok: true });
      } else if (route === "POST /api/publish") {
        publish(picked((await body(req)).dir));
        json(res, 200, { ok: true });
      } else if (route === "POST /api/thumbnail") { // an image from anywhere, copied into the job folder: only files in it are sent
        const dir = picked(url.searchParams.get("dir"));
        const name = basename(url.searchParams.get("name") ?? "").replace(/[^\p{L}\p{N} ._()-]/gu, "_");
        const ext = extname(name).toLowerCase();
        if (!IMAGE_MIME[ext] || name.startsWith(".")) throw fail(400, "pick a JPG, PNG, GIF, WebP or AVIF image");
        const data = await bytes(req, 50e6);
        let file = join(dir, name);
        for (let i = 2; existsSync(file); i++) file = join(dir, `${basename(name, ext)} ${i}${ext}`); // never overwrite
        writeFileSync(file, data, { flag: "wx" });
        json(res, 200, { name: basename(file), size: data.length });
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
