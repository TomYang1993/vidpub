// vidpub: upload videos to Bunny Stream, wait for encoding, then publish a post with the links.
//
// Usage: node vidpub.ts <job.json>     videos (+ optional collection and post), see job.example.json
//        node vidpub.ts <video.mp4>    single video, no collection, no post
//
// Safe to rerun anytime. Progress lives in <arg>.state.json: finished steps are skipped,
// half-done uploads resume, and videos Bunny fails get re-uploaded (MAX_ATTEMPTS per run).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Bunny, FAILED, HttpError, READY, RETRY_STATUS, VIDEO_TYPES, type Sleep } from "./bunny.ts";
import { PUBLISHERS, type Post, type Publisher, type Video } from "./publishers.ts";

export const MAX_ATTEMPTS = 3; // fresh uploads per video per run; rerunning is how you ask for more
const POLL_MS = 30_000;
const ENCODE_TIMEOUT_MS = 6 * 3600_000; // still not ready or failed after this = stuck, re-upload

export type Job = { path: string; videos: string[]; collection?: string; post?: Post; publish: string[] };
export type Host = Pick<Bunny, "findOrCreateCollection" | "createVideo" | "status" | "deleteVideo" | "tusCreate" | "tusUpload" | "playUrl" | "previewUrl">;
type Rec = { guid?: string; tusUrl?: string | null };
type State = { collection?: { name: string; id: string }; videos: Record<string, Rec>; published: Record<string, string> };

const stem = (p: string) => basename(p, extname(p));
const ready = (s: number | null) => s !== null && READY.has(s);
const settled = (s: number | null) => s === null || READY.has(s) || FAILED.has(s);

/** Read and validate a job up front: a typo should fail now, not after hours of uploading. */
export function loadJob(arg: string, publishers: Record<string, Publisher> = PUBLISHERS): Job {
  const path = resolve(arg);
  let job: Job = { path, videos: [path], publish: [] };
  if (extname(path).toLowerCase() === ".json") {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const at = (p: string) => resolve(dirname(path), p.replace(/^~(?=\/)/, homedir()));
    if (!Array.isArray(raw.videos) || !raw.videos.every((v: unknown) => typeof v === "string")) {
      throw new Error(`${path}: "videos" must be a list of file paths`);
    }
    job = {
      path,
      videos: raw.videos.map(at),
      collection: raw.collection,
      post: raw.post && { ...raw.post, thumbnail: raw.post.thumbnail && at(raw.post.thumbnail), attachments: (raw.post.attachments ?? []).map(at) },
      publish: raw.publish ?? (raw.post ? ["patreon_manual"] : []),
    };
  }
  const problems: string[] = [];
  if (!job.videos.length) problems.push("no videos");
  if (new Set(job.videos).size !== job.videos.length) problems.push("a video is listed twice");
  for (const v of job.videos) {
    if (!Object.hasOwn(VIDEO_TYPES, extname(v).toLowerCase())) problems.push(`not a video: ${v}`);
    else if (!existsSync(v)) problems.push(`missing: ${v}`);
  }
  if (job.post && !job.post.title) problems.push("post.title is required");
  for (const f of [job.post?.thumbnail, ...(job.post?.attachments ?? [])]) if (f && !existsSync(f)) problems.push(`missing: ${f}`);
  for (const p of job.publish) if (!Object.hasOwn(publishers, p)) problems.push(`unknown publisher: ${p}`);
  if (job.publish.length && !job.post) problems.push(`"publish" needs a "post"`);
  if (problems.length) throw new Error(`${path}:\n  ${problems.join("\n  ")}`);
  return job;
}

export async function run(job: Job, bunny: Host, opts: { sleep?: Sleep; publishers?: Record<string, Publisher> } = {}) {
  const { sleep = delay, publishers = PUBLISHERS } = opts;
  const statePath = `${job.path}.state.json`;
  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { videos: {}, published: {} };
  const save = () => {
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${statePath}.tmp`, statePath); // atomic: a crash never leaves half-written state
  };

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
      await upload(bunny, v, rec, collectionId, save, fresh);
    }
    const statuses = await waitEncoded(bunny, recs, sleep);
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
  for (const name of job.publish) {
    if (state.published[name]) continue;
    state.published[name] = await publishers[name](job.post!, videos, job.path);
    save();
  }
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
async function waitEncoded(bunny: Host, recs: Record<string, Rec>, sleep: Sleep) {
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
    const pending = Object.values(statuses).filter((s) => !settled(s)).length;
    if (!pending || Date.now() > deadline) return statuses;
    console.log(`encoding: ${pending}/${Object.keys(recs).length} pending`);
    await sleep(POLL_MS);
  }
}

function notify(msg: string) { // macOS notification. Runs take hours; say when they end.
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
  if (!BUNNY_LIBRARY_ID || !BUNNY_API_KEY) throw new Error("set BUNNY_LIBRARY_ID and BUNNY_API_KEY in .env");
  try {
    await run(job, new Bunny(BUNNY_LIBRARY_ID, BUNNY_API_KEY));
  } catch (e) {
    notify(`${basename(job.path)} failed: ${(e as Error).message}`);
    throw e;
  }
  notify(`${basename(job.path)}: done`);
}

if (process.argv[1] === import.meta.filename) await main();
