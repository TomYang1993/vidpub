// vidpub: upload videos to Bunny Stream, wait for encoding, build the post from a template, publish it.
//
// Usage: node vidpub.ts <job.json>     a template + its videos or images + a post, see job.*.example.json
//        node vidpub.ts <video.mp4>    single video, no collection, no post
//
// Flow: validate -> upload videos (if the template needs them) -> build the post into <job>.post.json ->
// publishers send exactly that file. Safe to rerun anytime: progress lives in <job>.state.json, finished
// steps are skipped, half-done uploads resume, and videos Bunny fails get re-uploaded (MAX_ATTEMPTS per run).
// The post file is the source of truth: edit it by hand to change the post; a job change rebuilds it unless
// it was hand-edited, in which case the run stops instead of overwriting or sending a stale post.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Bunny, FAILED, HttpError, READY, RETRY_STATUS, VIDEO_TYPES, type Sleep } from "./bunny.ts";
import { freeAccess, PUBLISHERS, type PostDoc, type Publisher, type Video } from "./publishers.ts";
import { attaches, expand, loadTemplates, usesBunny, type Template } from "./templates.ts";

export const MAX_ATTEMPTS = 3; // fresh uploads per video per run; rerunning is how you ask for more
const POLL_MS = 30_000;
const ENCODE_TIMEOUT_MS = 6 * 3600_000; // still not ready or failed after this = stuck, re-upload

/** A job's post settings: everything in PostDoc except the blocks, which the template builds from `text`. */
export type PostInput = Omit<PostDoc, "blocks"> & { text?: string };
export type Job = {
  path: string;
  template?: string;
  videos: string[];
  images: string[];
  collection?: string; // Bunny collection
  post?: PostInput;
  publish: string[];
};
export type Host = Pick<Bunny, "findOrCreateCollection" | "createVideo" | "status" | "deleteVideo" | "tusCreate" | "tusUpload" | "playUrl" | "previewUrl">;
type Rec = { guid?: string; tusUrl?: string | null };
type State = { collection?: { name: string; id: string }; videos: Record<string, Rec>; published: Record<string, string> };
/** Progress for a UI. statuses are Bunny's REST codes, -1 = check failed; publish fires before (no result) and after. */
export type RunEvent =
  | { type: "upload"; video: string; fresh: boolean; attempt: number }
  | { type: "encoding"; statuses: Record<string, number | null> }
  | { type: "ready"; videos: Video[] }
  | { type: "publish"; name: string; result?: string };
type OnEvent = (e: RunEvent) => void;
type DocFile = { inputs: string; built: string; doc: PostDoc }; // hashes of the job inputs and of the doc as built
export const IMAGE_TYPES = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic"]);

const stem = (p: string) => basename(p, extname(p));
const ready = (s: number | null) => s !== null && READY.has(s);
const settled = (s: number | null) => s === null || READY.has(s) || FAILED.has(s);

/** Read and validate a job up front: a typo should fail now, not after hours of uploading. */
export function loadJob(arg: string, publishers: Record<string, Publisher> = PUBLISHERS): Job {
  const path = resolve(arg);
  let job: Job = { path, videos: [path], images: [], publish: [] };
  const problems: string[] = [];
  if (extname(path).toLowerCase() === ".json") {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const at = (p: string) => resolve(dirname(path), p.replace(/^~(?=\/)/, homedir()));
    for (const key of ["videos", "images"]) {
      if (raw[key] !== undefined && (!Array.isArray(raw[key]) || !raw[key].every((v: unknown) => typeof v === "string"))) {
        throw new Error(`${path}: "${key}" must be a list of file paths`);
      }
    }
    if (raw.post?.content !== undefined) { // replaced by templates
      const text = String(raw.post.content).replace(/\{(links|previews)\}/g, "").trim();
      problems.push(`post.content is gone. Use "template": "video-previews" and "post": { "text": ${JSON.stringify(text)} } instead`);
    }
    job = {
      path,
      template: raw.template,
      videos: (raw.videos ?? []).map(at),
      images: (raw.images ?? []).map(at),
      collection: raw.collection,
      post: raw.post && { ...raw.post, thumbnail: raw.post.thumbnail && at(raw.post.thumbnail), attachments: (raw.post.attachments ?? []).map(at) },
      publish: raw.publish ?? (raw.post ? ["patreon_manual"] : []),
    };
  }
  const templates = loadTemplates();
  const template = typeof job.template === "string" && Object.hasOwn(templates, job.template) ? templates[job.template] : undefined;
  if (job.template && !template) problems.push(`unknown template: ${job.template} (have: ${Object.keys(templates).join(", ")})`);
  if (job.post && !job.template) problems.push(`a post needs a "template": ${Object.keys(templates).join(" or ")}`);
  if (template && !job[template.needs].length) problems.push(`template ${job.template} needs "${template.needs}"`);
  if (template && job.post && freeAccess(job.post.access) && template.blocks.some((b) => "paywall" in b)) {
    problems.push(`template ${job.template} has a paywall, which needs paid access, not "${job.post.access}"`);
  }
  if (!job.template && !job.videos.length) problems.push("no videos");
  for (const i of job.images) {
    if (!IMAGE_TYPES.has(extname(i).toLowerCase())) problems.push(`not an image: ${i}`);
    else if (!existsSync(i)) problems.push(`missing: ${i}`);
  }
  if (new Set(job.videos).size !== job.videos.length) problems.push("a video is listed twice");
  for (const v of job.videos) {
    if (!Object.hasOwn(VIDEO_TYPES, extname(v).toLowerCase())) problems.push(`not a video: ${v}`);
    else if (!existsSync(v)) problems.push(`missing: ${v}`);
  }
  if (job.post && !job.post.title) problems.push("post.title is required");
  if (job.post && !job.post.access) problems.push(`post.access is required: "public", "patrons", "paid" or a list of tiers`);
  for (const f of [job.post?.thumbnail, ...(job.post?.attachments ?? [])]) if (f && !existsSync(f)) problems.push(`missing: ${f}`);
  for (const p of job.publish) if (!Object.hasOwn(publishers, p)) problems.push(`unknown publisher: ${p}`);
  if (job.publish.length && !job.post) problems.push(`"publish" needs a "post"`);
  if (problems.length) throw new Error(`${path}:\n  ${problems.join("\n  ")}`);
  return job;
}

/** CLI flow: upload (if any videos), build the post doc, publish it. Image-only jobs never touch Bunny. */
export async function run(job: Job, bunny: Host | undefined, opts: { sleep?: Sleep; publishers?: Record<string, Publisher> } = {}) {
  if (needsBunny(job) && !bunny) throw new Error("videos need Bunny: set BUNNY_LIBRARY_ID and BUNNY_API_KEY in .env");
  const videos = needsBunny(job) ? await uploadVideos(job, bunny!, opts.sleep) : localVideos(job);
  if (job.post) {
    buildPost(job, videos);
    await publishPost(job, opts.publishers);
  }
  return videos;
}

const statePath = (job: Job) => `${job.path}.state.json`;
export const postPath = (job: Job) => `${job.path}.post.json`;
const readJson = <T>(path: string): T | undefined => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined);
function writeJson(path: string, data: unknown) {
  rmSync(`${path}.tmp`, { force: true }); // never write through a symlink planted at the temp name
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2), { flag: "wx" });
  renameSync(`${path}.tmp`, path); // atomic: a crash never leaves a half-written file
}
const readState = (job: Job): State => readJson<State>(statePath(job)) ?? { videos: {}, published: {} };
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);
const templateOf = (job: Job): Template => loadTemplates()[job.template!];
/** Whether the job's videos go to Bunny: always without a template (a plain upload), else only if the template shows
 *  something from Bunny. An attachments-only template sends the files to Patreon and never touches Bunny. */
export const needsBunny = (job: Job) => job.videos.length > 0 && (!job.template || usesBunny(templateOf(job)));
/** The job's videos as the template sees them when they aren't on Bunny: names only, no URLs. */
export const localVideos = (job: Job): Video[] => job.videos.map((v) => ({ title: stem(v), url: "" }));
/** Everything the post is built from, the template's layout included. Videos count by Bunny guid, so a re-upload
 *  means a rebuild. */
const inputsHash = (job: Job, state: State) =>
  hash([job.template, templateOf(job), job.post, job.images, job.videos.map((v) => state.videos[v]?.guid ?? null)]);

/**
 * Build <job>.post.json from the template, or keep it if the job hasn't changed (hand edits survive).
 * Throws if the job changed and the doc was hand-edited: neither overwriting nor sending it would be right.
 */
export function buildPost(job: Job, videos: Video[]): PostDoc {
  const inputs = inputsHash(job, readState(job));
  const file = readJson<DocFile>(postPath(job));
  if (file?.inputs === inputs) return file.doc;
  if (file && hash(file.doc) !== file.built) {
    throw new Error(`${postPath(job)} was edited by hand, and the job changed since. Delete it to rebuild from the job, or undo the job change.`);
  }
  const { text, ...settings } = job.post!;
  const t = templateOf(job);
  const files = attaches(t) ? (t.needs === "videos" ? job.videos : job.images) : []; // the job's own files, attached
  const attachments = [...new Set([...(settings.attachments ?? []), ...files])];
  const doc: PostDoc = { ...settings, ...(attachments.length ? { attachments } : {}), blocks: expand(t, text, { videos, images: job.images }) };
  writeJson(postPath(job), { inputs, built: hash(doc), doc } satisfies DocFile);
  return doc;
}

/** Save a hand-edited doc (e.g. from a GUI). It stays tied to the job inputs it was built from. */
export function savePost(job: Job, doc: PostDoc) {
  const file = readJson<DocFile>(postPath(job));
  if (!file) throw new Error(`no ${postPath(job)} yet: build the post first`);
  writeJson(postPath(job), { ...file, doc });
}

/** Send <job>.post.json, exactly as saved, to each publisher that hasn't run yet. */
export async function publishPost(job: Job, publishers: Record<string, Publisher> = PUBLISHERS, onEvent: OnEvent = () => {}) {
  const state = readState(job);
  const pending = job.publish.filter((name) => !state.published[name]);
  if (!pending.length) return;
  const file = readJson<DocFile>(postPath(job));
  if (!file) throw new Error(`no ${postPath(job)} yet: build the post first`);
  if (file.inputs !== inputsHash(job, state)) throw new Error(`the job changed since ${postPath(job)} was built: rebuild and review it before publishing`);
  for (const name of pending) {
    onEvent({ type: "publish", name });
    state.published[name] = await publishers[name](file.doc, job.path);
    writeJson(statePath(job), state);
    onEvent({ type: "publish", name, result: state.published[name] });
  }
}

/** Upload every video and wait until all are playable. Returns them in job order. */
export async function uploadVideos(job: Job, bunny: Host, sleep: Sleep = delay, onEvent: OnEvent = () => {}): Promise<Video[]> {
  const state = readState(job);
  const save = () => writeJson(statePath(job), state);

  if (job.collection && state.collection?.name !== job.collection) {
    state.collection = { name: job.collection, id: await bunny.findOrCreateCollection(job.collection) };
    save();
  }
  const collectionId = job.collection ? state.collection?.id : undefined;
  const recs: Record<string, Rec> = {};
  for (const v of job.videos) recs[v] = state.videos[v] ??= {};
  const attempts: Record<string, number> = Object.fromEntries(job.videos.map((v) => [v, 0]));
  let stuck = new Set<string>();

  while (true) {
    // ponytail: one upload at a time; parallel uploads would share the same uplink anyway
    for (const v of job.videos) {
      const rec = recs[v];
      const s = rec.guid ? await bunny.status(rec.guid) : null;
      const fresh = s === null || FAILED.has(s) || stuck.has(v);
      if (!fresh && s !== 0) continue; // ready, or uploaded and encoding
      if (fresh && ++attempts[v] > MAX_ATTEMPTS) throw new Error(`${basename(v)}: gave up after ${MAX_ATTEMPTS} uploads (Bunny status ${s})`);
      console.log(`${fresh ? "uploading" : "resuming"} ${basename(v)}`);
      onEvent({ type: "upload", video: v, fresh, attempt: attempts[v] });
      await upload(bunny, v, rec, collectionId, save, fresh);
    }
    const statuses = await waitEncoded(bunny, recs, sleep, onEvent);
    const notReady = Object.keys(statuses).filter((v) => !ready(statuses[v]));
    if (!notReady.length) break;
    stuck = new Set(notReady.filter((v) => !settled(statuses[v])));
    console.log(`retrying: ${notReady.map((v) => basename(v)).join(", ")}`);
  }

  const videos: Video[] = [];
  for (const v of job.videos) {
    videos.push({ title: stem(v), url: bunny.playUrl(recs[v].guid!), preview: await bunny.previewUrl(recs[v].guid!) });
  }
  for (const v of videos) console.log(`${v.title}: ${v.url}`);
  onEvent({ type: "ready", videos });
  return videos;
}

/** Get the file's bytes onto Bunny. fresh = throw away the current video and start over. */
async function upload(bunny: Host, path: string, rec: Rec, collectionId: string | undefined, save: () => void, fresh: boolean) {
  if (fresh) {
    if (rec.guid) await bunny.deleteVideo(rec.guid);
    rec.guid = await bunny.createVideo(stem(path), collectionId);
    rec.tusUrl = null;
    save();
  }
  const guid = rec.guid!;
  for (let i = 0; i < 2; i++) { // 2nd pass only when a saved upload had already expired on Bunny's side
    if (!rec.tusUrl) {
      rec.tusUrl = await bunny.tusCreate(path, guid, stem(path), collectionId);
      save();
    }
    if (await bunny.tusUpload(path, guid, rec.tusUrl)) return;
    rec.tusUrl = null;
    save();
  }
  throw new Error(`${basename(path)}: a brand-new upload expired immediately`);
}

/** Poll until every video is ready or failed, or ENCODE_TIMEOUT_MS passes. */
async function waitEncoded(bunny: Host, recs: Record<string, Rec>, sleep: Sleep, onEvent: OnEvent) {
  const deadline = Date.now() + ENCODE_TIMEOUT_MS;
  while (true) {
    const statuses: Record<string, number | null> = {};
    for (const [v, rec] of Object.entries(recs)) {
      try {
        statuses[v] = await bunny.status(rec.guid!);
      } catch (e) {
        if (e instanceof HttpError && !RETRY_STATUS.has(e.status)) throw e;
        console.log(`status check failed for ${basename(v)}: ${(e as Error).message}`); // blip: keep waiting
        statuses[v] = -1;
      }
    }
    onEvent({ type: "encoding", statuses });
    const pending = Object.values(statuses).filter((s) => !settled(s)).length;
    if (!pending || Date.now() > deadline) return statuses;
    console.log(`encoding: ${pending}/${Object.keys(recs).length} pending`);
    await sleep(POLL_MS);
  }
}

export function notify(msg: string) { // macOS notification. Runs take hours; say when they end.
  spawnSync("osascript", ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "vidpub"', "-e", "end run", msg]);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node vidpub.ts <job.json | video file>");
    process.exit(2);
  }
  const job = loadJob(arg);
  const envPath = join(import.meta.dirname, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const { BUNNY_LIBRARY_ID, BUNNY_API_KEY } = process.env;
  const bunny = BUNNY_LIBRARY_ID && BUNNY_API_KEY ? new Bunny(BUNNY_LIBRARY_ID, BUNNY_API_KEY) : undefined;
  try {
    await run(job, bunny);
  } catch (e) {
    notify(`${basename(job.path)} failed: ${(e as Error).message}`);
    throw e;
  }
  notify(`${basename(job.path)}: done`);
}

if (process.argv[1] === import.meta.filename) await main();
