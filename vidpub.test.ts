// No network: npm test
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bunny } from "./bunny.ts";
import { collectionsOf, contentHtml, patreonManual, type PostDoc } from "./publishers.ts";
import { deleteVideos, download, moveVideos, pickVariant, popularity, proposeCleanup, readDeleted, searchVideos } from "./library.ts";
import { attaches, BUILTIN, checkTemplate, deleteTemplate, expand, loadTemplates, saveTemplate, usesBunny } from "./templates.ts";
import { MAX_ATTEMPTS, buildPost, loadJob, publishPost, run, savePost } from "./vidpub.ts";

const tmp = mkdtempSync(join(tmpdir(), "vidpub-"));
process.env.VIDPUB_TEMPLATES = join(tmp, "templates"); // never the user's own saved templates
const noSleep = async () => {};

function job(name: string, files: string[], spec?: object) {
  const dir = join(tmp, name);
  mkdirSync(dir);
  for (const f of files) writeFileSync(join(dir, f), "x");
  if (!spec) return join(dir, files[0]);
  writeFileSync(join(dir, "job.json"), JSON.stringify(spec));
  return join(dir, "job.json");
}

/** Each upload of <title> ends in the next status from outcomes[title]. */
class FakeBunny {
  outcomes: Record<string, number[]>;
  videos = new Map<string, number>();
  created: { guid: string; collectionId?: string }[] = [];
  constructor(outcomes: Record<string, number[]>) {
    this.outcomes = outcomes;
  }
  async findOrCreateCollection(name: string) {
    return `col:${name}`;
  }
  async createVideo(title: string, collectionId?: string) {
    const guid = `${title}-${this.created.length + 1}`;
    this.created.push({ guid, collectionId });
    this.videos.set(guid, 0);
    return guid;
  }
  async tusCreate(_path: string, guid: string) {
    return `tus/${guid}`;
  }
  async tusUpload(_path: string, guid: string) {
    this.videos.set(guid, this.outcomes[guid.split("-")[0]].shift()!);
    return true;
  }
  async status(guid: string) {
    return this.videos.get(guid) ?? null;
  }
  async deleteVideo(guid: string) {
    this.videos.delete(guid);
  }
  playUrl(guid: string) {
    return `https://play/${guid}`;
  }
  async previewUrl(guid: string) {
    return `https://cdn/${guid}/preview.webp`;
  }
}

function recorder() {
  const calls: PostDoc[] = [];
  return { calls, publishers: { patreon_manual: (doc: PostDoc) => (calls.push(doc), "posted") } };
}

test("TUS upload resumes from the server's offset after a dropped connection", async () => {
  const file = join(tmp, "v.mp4");
  const bytes = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
  writeFileSync(file, bytes);
  let received = Buffer.alloc(0);
  let patches = 0;
  const fetch = async (_url: string, init: RequestInit) => {
    if (init.method === "HEAD") return new Response(null, { headers: { "Upload-Offset": String(received.length) } });
    assert.equal(Number((init.headers as Record<string, string>)["Upload-Offset"]), received.length);
    const chunk = Buffer.from(init.body as Uint8Array);
    if (++patches === 2) { // server keeps half the chunk, then the connection drops
      received = Buffer.concat([received, chunk.subarray(0, chunk.length >> 1)]);
      throw new TypeError("fetch failed");
    }
    received = Buffer.concat([received, chunk]);
    return new Response(null, { status: 204, headers: { "Upload-Offset": String(received.length) } });
  };
  const bunny = new Bunny(1, "key", { fetch, sleep: noSleep, chunk: 100 });
  assert.equal(await bunny.tusUpload(file, "vid", "https://tus/x"), true);
  assert.deepEqual(received, bytes);

  const expired = new Bunny(1, "key", { fetch: async () => new Response(null, { status: 404 }), sleep: noSleep });
  assert.equal(await expired.tusUpload(file, "vid", "https://tus/x"), false);
});

test("job: failed encode is replaced, publish runs once, rerun is a no-op", async () => {
  const path = job("ok", ["b.mp4", "a.mp4", "notes.pdf"], {
    template: "video-previews",
    collection: "Oct",
    videos: ["b.mp4", "a.mp4"],
    post: { title: "Oct", text: "Free:", access: "public", attachments: ["notes.pdf"] },
  });
  const fake = new FakeBunny({ a: [4], b: [5, 4] }); // b fails encoding once
  const rec = recorder();
  await run(loadJob(path, rec.publishers), fake, { sleep: noSleep, publishers: rec.publishers });
  assert.deepEqual(fake.created.map((c) => c.guid), ["b-1", "a-2", "b-3"]);
  assert.ok(fake.created.every((c) => c.collectionId === "col:Oct"));
  assert.ok(!fake.videos.has("b-1"));
  assert.deepEqual(rec.calls[0].blocks, [
    { text: "Free:" },
    { image: "https://cdn/b-3/preview.webp" }, { link: "https://play/b-3" },
    { image: "https://cdn/a-2/preview.webp" }, { link: "https://play/a-2" },
  ]);
  assert.deepEqual(rec.calls[0].attachments, [join(tmp, "ok", "notes.pdf")]);

  await run(loadJob(path, rec.publishers), fake, { sleep: noSleep, publishers: rec.publishers });
  assert.equal(fake.created.length, 3);
  assert.equal(rec.calls.length, 1);
});

test("gives up after MAX_ATTEMPTS and publishes nothing", async () => {
  const path = job("bad", ["c.mp4"], { template: "video-previews", videos: ["c.mp4"], post: { title: "t", access: "public" } });
  const fake = new FakeBunny({ c: Array(MAX_ATTEMPTS).fill(5) });
  const rec = recorder();
  await assert.rejects(run(loadJob(path, rec.publishers), fake, { sleep: noSleep, publishers: rec.publishers }), /c\.mp4: gave up/);
  assert.equal(fake.created.length, MAX_ATTEMPTS);
  assert.equal(rec.calls.length, 0);
});

test("single video: no collection, no post", async () => {
  const fake = new FakeBunny({ solo: [4] });
  const videos = await run(loadJob(job("solo", ["solo.mov"])), fake, { sleep: noSleep });
  assert.deepEqual(fake.created, [{ guid: "solo-1", collectionId: undefined }]);
  assert.deepEqual(videos, [{ title: "solo", url: "https://play/solo-1", preview: "https://cdn/solo-1/preview.webp" }]);
});

test("bad job lists every problem before uploading anything", () => {
  const path = job("typos", ["a.mp4"], { videos: ["a.mp4", "gone.mp4", "a.mp4", "readme.txt"], post: { thumbnail: "x.jpg" }, publish: ["nope"] });
  assert.throws(() => loadJob(path), (e: Error) =>
    ["listed twice", "missing: " + join(tmp, "typos", "gone.mp4"), "not a video", "post.title", "post.access", "needs a \"template\"", "x.jpg", "unknown publisher: nope"]
      .every((s) => e.message.includes(s)));
});

test("image-gallery: image-only job never touches Bunny", async () => {
  const path = job("gallery", ["a.jpg", "b.png"], {
    template: "image-gallery", images: ["a.jpg", "b.png"], post: { title: "Pics", text: "On top", access: "public" },
  });
  const rec = recorder();
  assert.deepEqual(await run(loadJob(path, rec.publishers), undefined, { publishers: rec.publishers }), []);
  assert.deepEqual(rec.calls[0].blocks, [{ text: "On top" }, { image: join(tmp, "gallery", "a.jpg") }, { image: join(tmp, "gallery", "b.png") }]);
});

test("templates: video-previews without text, image-gallery", () => {
  const [previews, gallery] = BUILTIN;
  const videos = [{ title: "a", url: "u1", preview: "p1" }, { title: "b", url: "u2" }];
  assert.deepEqual(expand(previews, undefined, { videos }), [{ image: "p1" }, { link: "u1" }, { link: "u2" }]);
  assert.deepEqual(expand(gallery, "  Hi \n", { images: ["/x.jpg"] }), [{ text: "Hi" }, { image: "/x.jpg" }]);
});

test("saved template: blocks and repeat sections, all block types; saving overrides a built-in", () => {
  const t = saveTemplate({
    name: "Member videos", needs: "videos",
    blocks: [
      { text: "{text}" }, { text: "{count} videos this week" },
      { repeat: [{ image: "{preview}" }, { text: "{n}. {name}" }, { button: { text: "Play {n}", url: "{play}", caption: "{name}" } }] },
      { divider: true },
      { repeat: [{ link: "{play}" }] },
      { paywall: true }, { text: "Thanks!" },
    ],
  });
  assert.equal(t.id, "member-videos");
  assert.equal(loadTemplates()["member-videos"].name, "Member videos");
  const videos = [{ title: "a", url: "https://p/1", preview: "https://c/1.webp" }, { title: "b", url: "https://p/2" }];
  assert.deepEqual(expand(t, "", { videos }), [
    { text: "2 videos this week" },
    { image: "https://c/1.webp" }, { text: "1. a" }, { button: { text: "Play 1", url: "https://p/1", caption: "a" } },
    { text: "2. b" }, { button: { text: "Play 2", url: "https://p/2", caption: "b" } }, // no preview: its image drops out
    { divider: true },
    { link: "https://p/1" }, { link: "https://p/2" },
    { paywall: true }, { text: "Thanks!" },
  ]);
  const long = checkTemplate({ name: "long", needs: "videos", blocks: [{ repeat: [{ button: { text: "{name}", url: "{play}" } }] }] });
  assert.throws(() => expand(long, "", { videos: [{ title: "x".repeat(36), url: "https://p" }] }), /over Patreon's 35 characters/);
  saveTemplate({ ...BUILTIN[0], id: undefined, name: "Video previews", blocks: [{ repeat: [{ link: "{play}" }] }] });
  assert.deepEqual(loadTemplates()["video-previews"].blocks, [{ repeat: [{ link: "{play}" }] }]);
  deleteTemplate("video-previews");
  assert.deepEqual(loadTemplates()["video-previews"].blocks[0], { text: "{text}" });
});

test("bad templates list every problem", () => {
  assert.throws(() => checkTemplate({
    name: "x", needs: "videos",
    blocks: [
      { image: "/etc/passwd" }, { paywall: true }, { text: "{play}" }, { button: { text: "go", url: "file:///x" } },
      { repeat: [{ paywall: true }, { link: "javascript:alert(1)" }, { repeat: [] }] },
      { paywall: true },
    ],
  }), (e: Error) => {
    for (const p of ["an image is an https", "{play} isn't available here", "a paywall can't repeat", "a link starts with",
      "repeat sections can't nest", "only one paywall", "a button's url starts with https"]) {
      assert.match(e.message, new RegExp(p.replace(/[{}]/g, "\\$&")));
    }
    return true;
  });
  assert.throws(() => checkTemplate({ name: "y", needs: "videos", blocks: [{ text: "hi" }] }), /add a repeat section/);
  const path = job("paywall-free", ["a.mp4"], { template: "pw", videos: ["a.mp4"], post: { title: "t", access: "public" } });
  saveTemplate({ name: "pw", needs: "videos", blocks: [{ paywall: true }, { repeat: [{ link: "{play}" }] }] });
  assert.throws(() => loadJob(path), /has a paywall, which needs paid access/);
});

test("post doc is the source of truth: hand edits kept, never overwritten or sent stale", async () => {
  const spec = (text: string) => ({ template: "image-gallery", images: ["a.jpg"], post: { title: "T", text, access: "public" }, publish: [] });
  const path = job("truth", ["a.jpg"], spec("one"));
  const j = () => loadJob(path);
  assert.deepEqual(buildPost(j(), []).blocks[0], { text: "one" });
  writeFileSync(path, JSON.stringify(spec("two"))); // job changed, doc untouched: rebuild
  assert.deepEqual(buildPost(j(), []).blocks[0], { text: "two" });
  savePost(j(), { ...buildPost(j(), []), title: "edited" }); // hand edit: kept while the job stays the same
  assert.equal(buildPost(j(), []).title, "edited");
  writeFileSync(path, JSON.stringify({ ...spec("three"), publish: ["patreon_manual"] })); // job changed after a hand edit
  assert.throws(() => buildPost(j(), []), /edited by hand/);
  await assert.rejects(publishPost(j(), recorder().publishers), /job changed/);
});

test("old post.content fails with the template to use instead", () => {
  const path = job("old", ["a.mp4"], { videos: ["a.mp4"], post: { title: "t", access: "public", content: "Hi\n\n{previews}" } });
  assert.throws(() => loadJob(path), /"template": "video-previews" and "post": \{ "text": "Hi" \}/);
});

test("post HTML: escaped, URLs linked", () => {
  assert.equal(contentHtml('<b> & "x"\nhttps://p.net/a?b=1&c=2'),
    '<p>&#60;b&#62; &#38; &#34;x&#34;</p><p><a href="https://p.net/a?b=1&#38;c=2">https://p.net/a?b=1&#38;c=2</a></p>');
});

/** A fake library: records API calls, answers from `videos`, serves `files` as CDN responses. */
function fakeLibrary(files: Record<string, Response | (() => Response)> = {}) {
  const calls: [string, string, object?][] = [];
  const id = "11111111-2222-4333-8444-555555555555";
  const video = { guid: id, title: 'Clip: "one"/two.mp4', collectionId: "", views: 3, length: 10, thumbnailUrl: "https://vz-x.b-cdn.net/11111111-2222-4333-8444-555555555555/thumbnail.jpg" };
  const lib = {
    calls, id,
    async api(method: string, path: string, body?: object) {
      calls.push([method, path, body]);
      if (path.startsWith("/videos?")) return { totalItems: 1, currentPage: 1, itemsPerPage: 50, items: [video] };
      if (path === `/videos/${id}`) return method === "GET" ? video : {};
      if (path.startsWith("/statistics")) return { viewsChart: { "2026-10-18T00:00:00Z": 2 }, watchTimeChart: {}, countryViewCounts: { US: 2 }, engagementScore: 0 };
      if (path.endsWith("/heatmap")) return { heatmap: { 1: 5, 0: 9 } };
      if (path.endsWith("/resolutions")) return { data: { mp4Resolutions: [{ resolution: "720p" }, { resolution: "1080p" }], playlistResolutions: [{ resolution: "1080p" }] } };
      throw new Error(`unexpected ${method} ${path}`);
    },
    async fetch(url: string) {
      const f = files[url];
      return typeof f === "function" ? f() : f ?? new Response("nope", { status: 404 });
    },
    async findOrCreateCollection() { return "c"; },
  };
  return lib;
}

test("library: search params, move takes ids and empty collection, rejects non-ids before calling Bunny", async () => {
  const lib = fakeLibrary();
  const page = await searchVideos(lib, { search: " clip ", collection: lib.id, page: 2, orderBy: "title" });
  assert.equal(page.items[0].id, lib.id);
  assert.match(lib.calls[0][1], /search=clip.*|collection=/);
  assert.ok(lib.calls[0][1].includes("orderBy=title") && lib.calls[0][1].includes("page=2"));
  await assert.rejects(searchVideos(lib, { collection: "../../x" }), /not a collection id/);
  lib.calls.length = 0;
  assert.equal(await moveVideos(lib, [lib.id], ""), 1);
  assert.deepEqual(lib.calls, [["POST", `/videos/${lib.id}`, { collectionId: "" }]]);
  await assert.rejects(moveVideos(lib, ["x/../../collections/y"], ""), /not a video id/);
});

test("library: HLS variant pick prefers 1080p, else the best below it", () => {
  const m = (...hs: number[]) => hs.map((h, i) => `#EXT-X-STREAM-INF:BANDWIDTH=${i},RESOLUTION=${(h * 16) / 9}x${h}\n${h}p/video.m3u8`).join("\n");
  assert.deepEqual(pickVariant(m(360, 1080, 720), "https://cdn/v/playlist.m3u8"), { height: 1080, url: "https://cdn/v/1080p/video.m3u8" });
  assert.equal(pickVariant(m(480, 720, 1440), "https://cdn/v/playlist.m3u8")!.height, 720);
  assert.equal(pickVariant(m(1440, 2160), "https://cdn/v/playlist.m3u8")!.height, 1440); // nothing at or under 1080
  assert.equal(pickVariant("#EXTM3U", "https://cdn/v/playlist.m3u8"), null);
});

test("library download: the 1080p MP4 lands under a safe new name with progress; a 403 explains itself and leaves nothing", async () => {
  const dir = join(tmp, "dl");
  mkdirSync(dir);
  const url = "https://vz-x.b-cdn.net/11111111-2222-4333-8444-555555555555/play_1080p.mp4";
  const lib = fakeLibrary({ [url]: () => new Response("0123456789", { headers: { "content-length": "10" } }) });
  const seen: number[] = [];
  const saved = await download(lib, lib.id, dir, (p) => seen.push(p));
  assert.equal(saved.path, join(dir, "Clip_ _one_two.mp4"));
  assert.equal(readFileSync(saved.path, "utf8"), "0123456789");
  assert.equal(saved.height, 1080);
  assert.equal(seen.at(-1), 100);
  assert.equal((await download(lib, lib.id, dir)).path, join(dir, "Clip_ _one_two 2.mp4")); // never overwrites
  const locked = fakeLibrary({ [url]: new Response("", { status: 403 }) });
  await assert.rejects(download(locked, locked.id, dir), /refused the download.*Block direct URL/);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".part")), []);
  assert.ok(!existsSync(join(dir, "Clip_ _one_two 3.mp4")));
});

test("popularity: views this period vs the one before, ranked; collections summed", async () => {
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  const [a, b, c] = ["aaaaaaaa", "bbbbbbbb", "cccccccc"].map((p) => `${p}-0000-4000-8000-000000000000`);
  const videos = [{ guid: a, title: "A", collectionId: "c1", views: 50 }, { guid: b, title: "B", collectionId: "c1", views: 9 }, { guid: c, title: "C", collectionId: "", views: 1 }];
  const watch = { [`${day(0)}T00:00:00Z`]: 300, [`${day(9)}T00:00:00Z`]: 99 }; // seconds; only today's counts this period
  const charts: Record<string, Record<string, number>> = { // last 7 days = this period, the 7 before = previous
    [a]: { [`${day(10)}T00:00:00Z`]: 8, [`${day(1)}T00:00:00Z`]: 2 },
    [b]: { [`${day(0)}T00:00:00Z`]: 5, [`${day(3)}T00:00:00Z`]: 1 },
    [c]: {},
  };
  const lib = {
    async api(_m: string, path: string) {
      if (path.startsWith("/videos?")) return { totalItems: 3, items: videos };
      const g = new URLSearchParams(path.split("?")[1]).get("videoGuid")!;
      return { viewsChart: charts[g], watchTimeChart: g === b ? watch : {} };
    },
    async fetch() { return new Response(); },
    async findOrCreateCollection() { return ""; },
  };
  const seen: number[] = [];
  const p = await popularity(lib, 7, (done) => seen.push(done));
  assert.deepEqual(p.videos.map((v) => [v.title, v.views, v.prev]), [["B", 6, 0], ["A", 2, 8], ["C", 0, 0]]);
  assert.equal(p.videos[0].daily.length, 7);
  assert.equal(p.videos[0].daily.at(-1), 5); // today is the last day
  assert.equal(p.videos[0].watch, 300);
  assert.deepEqual(p.collections.map((x) => [x.collectionId, x.videos, x.views, x.prev, x.watch]), [["c1", 2, 8, 8, 300], ["", 1, 0, 0, 0]]);
  assert.deepEqual(seen.sort(), [1, 2, 3]);
});

test("cleanup proposal: rules, least-viewed then biggest first, reasons, posted videos kept out unless asked", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const v = (id: string, views: number, total: number, size: number, age: number) =>
    ({ id, title: id, collectionId: "", views, prev: 0, total, size, dateUploaded: ago(age), length: 60, daily: [], watch: 0 });
  const p = { days: 90, from: "", to: "", at: "", checked: 6, collections: [], videos: [
    v("big-unwatched", 0, 3, 5e9, 200), v("small-unwatched", 0, 0, 1e8, 200), v("one-view", 1, 9, 9e9, 300),
    v("popular", 50, 500, 9e9, 300), v("too-new", 0, 0, 9e9, 10), v("in-a-post", 0, 0, 8e9, 400)] };
  const posted = new Map([["in-a-post", "Oct 03 posts"]]);
  const r = proposeCleanup(p as never, { maxViews: 1, minAgeDays: 60, limit: 10 }, { posted, now });
  assert.deepEqual(r.videos.map((x) => x.id), ["big-unwatched", "small-unwatched", "one-view"]);
  assert.deepEqual(r.videos[0].reasons, ["no views in the last 90 days", "3 views ever", "uploaded 200 days ago"]);
  assert.deepEqual(r.videos[1].reasons.slice(1, 2), ["never watched"]);
  assert.equal(r.videos[2].reasons[0], "1 view in the last 90 days");
  assert.equal(r.totalSize, 5e9 + 1e8 + 9e9);
  assert.equal(r.skippedPosted, 1);
  const withPosts = proposeCleanup(p as never, { maxViews: 0, minAgeDays: 60, limit: 1 }, { posted, now, includePosted: true });
  assert.deepEqual(withPosts.videos.map((x) => [x.id, x.post]), [["in-a-post", "Oct 03 posts"]]); // biggest first
  assert.equal(withPosts.matching, 3);
});

test("delete: logged only once Bunny deletes; already-gone counts as deleted; one failure doesn't stop the rest", async () => {
  const [a, b, c] = ["aaaaaaaa", "bbbbbbbb", "cccccccc"].map((x) => `${x}-0000-4000-8000-000000000000`);
  const deletes: string[] = [];
  const lib = {
    async api(method: string, path: string) {
      const id = path.split("/")[2];
      if (method === "GET") {
        if (id === c) throw new Error("HTTP 404: gone");
        return { title: `t-${id.slice(0, 1)}`, storageSize: 100, views: 2, collectionId: "" };
      }
      if (id === b) throw new Error("HTTP 500: boom");
      deletes.push(id);
      return null;
    },
    async fetch() { return new Response(); },
    async findOrCreateCollection() { return ""; },
  };
  const log = join(tmp, "deleted", "deleted.jsonl");
  const r = await deleteVideos(lib, [a, b, c], log, { [a]: "no views in the last 90 days" });
  assert.deepEqual(r.deleted, [a, c]);
  assert.deepEqual(r.failed.map((f) => f.id), [b]);
  assert.deepEqual(deletes, [a]);
  const h = readDeleted(log);
  assert.equal(h.count, 1); // b failed, c was already gone: neither is logged as deleted by us
  assert.deepEqual([h.recent[0].id, h.recent[0].reason, h.bytes], [a, "no views in the last 90 days", 100]);
  await assert.rejects(deleteVideos(lib, ["../collections/x"], log), /not a video id/);
});

test("attachments template: the files go on the post, nothing goes to Bunny", async () => {
  const t = checkTemplate({ name: "Files", needs: "videos", blocks: [{ attachments: true }, { text: "{text}" }] });
  assert.deepEqual(t.blocks, [{ text: "{text}" }, { attachments: true }]); // kept last: Patreon shows them below the post
  assert.ok(attaches(t) && !usesBunny(t));
  assert.ok(usesBunny(BUILTIN[0]) && !attaches(BUILTIN[0]));
  assert.throws(() => checkTemplate({ name: "x", needs: "videos", blocks: [{ repeat: [{ attachments: true }] }] }), /outside the repeat section/);
  assert.throws(() => checkTemplate({ name: "x", needs: "videos", blocks: [{ attachments: true }, { attachments: true }] }), /attachments only once/);
  assert.throws(() => checkTemplate({ name: "x", needs: "videos", blocks: [{ text: "hi" }] }), /add a repeat section or attachments/);
  saveTemplate({ name: "Files", needs: "videos", blocks: [{ text: "{text}" }, { attachments: true }] });
  const path = job("attach", ["b.mp4", "a.mp4", "notes.pdf"], {
    template: "files", videos: ["a.mp4", "b.mp4"], post: { title: "T", text: "Here they are", access: "paid", attachments: ["notes.pdf"] }, publish: ["patreon_manual"],
  });
  const rec = recorder();
  const j = loadJob(path, rec.publishers);
  await run(j, undefined, { publishers: rec.publishers }); // no Bunny client at all: it isn't needed
  assert.deepEqual(rec.calls[0].blocks, [{ text: "Here they are" }]);
  assert.deepEqual(rec.calls[0].attachments, ["notes.pdf", "a.mp4", "b.mp4"].map((f) => join(tmp, "attach", f)));
  deleteTemplate("files");
});

test("Patreon collections: one name or a list; anything else is refused; the manual checklist lists them all", () => {
  assert.deepEqual(collectionsOf({ collection: "Asia" }), ["Asia"]);
  assert.deepEqual(collectionsOf({ collection: ["Asia", "Europa America", "Asia", ""] }), ["Asia", "Europa America"]);
  assert.deepEqual(collectionsOf({}), []);
  const spec = (collection: unknown) => ({ template: "image-gallery", images: ["a.jpg"], post: { title: "T", access: "paid", collection }, publish: [] });
  assert.doesNotThrow(() => loadJob(job("coll-ok", ["a.jpg"], spec(["Asia", "Europa America"]))));
  assert.throws(() => loadJob(job("coll-bad", ["a.jpg"], spec([1, 2]))), /post.collection is a Patreon collection name or a list/);
  const out = join(tmp, "coll-manual");
  patreonManual({ title: "T", access: "paid", collection: ["Asia", "Europa America"], blocks: [] }, out);
  assert.match(readFileSync(`${out}.patreon.txt`, "utf8"), /Collections: Asia, Europa America/);
});

test("an interrupted send records its draft, and the next send finishes that draft", async () => {
  const path = job("resume", ["a.jpg"], { template: "image-gallery", images: ["a.jpg"], post: { title: "T", access: "paid" }, publish: ["p"] });
  const seen: (string | undefined)[] = [];
  let first = true;
  const publishers = {
    p: (_doc: PostDoc, _job: string, opts?: { draft?: string; onDraft?: (url: string) => void }) => {
      seen.push(opts?.draft);
      opts?.onDraft?.(opts.draft ?? "https://www.patreon.com/posts/42/edit");
      if (first) { first = false; throw new Error("Chrome closed"); } // interrupted after the draft existed
      return "https://www.patreon.com/posts/42/edit";
    },
  };
  const j = loadJob(path, publishers);
  buildPost(j, []);
  await assert.rejects(publishPost(j, publishers), /Chrome closed/);
  const state = () => JSON.parse(readFileSync(`${path}.state.json`, "utf8"));
  assert.deepEqual(state().drafts, { p: "https://www.patreon.com/posts/42/edit" });
  assert.deepEqual(state().published, {});
  await publishPost(j, publishers);
  assert.deepEqual(seen, [undefined, "https://www.patreon.com/posts/42/edit"]); // the second send was handed the draft
  assert.equal(state().published.p, "https://www.patreon.com/posts/42/edit");
});

test("a job from Bunny videos: no uploads, play links and previews from Bunny; bad lists are refused", async () => {
  const [a, b] = ["aaaaaaaa", "bbbbbbbb"].map((x) => `${x}-1111-4111-8111-111111111111`);
  const spec = (extra: object) => ({ template: "video-previews", post: { title: "T", text: "From Bunny", access: "paid" }, publish: ["patreon_manual"], ...extra });
  const path = job("from-bunny", ["x.txt"], spec({ bunny: [{ id: b, title: "Second" }, { id: a, title: "First" }] }));
  const bunny = new FakeBunny({});
  bunny.videos.set(a, 4);
  bunny.videos.set(b, 4);
  const rec = recorder();
  await run(loadJob(path, rec.publishers), bunny as never, { publishers: rec.publishers });
  assert.equal(bunny.created.length, 0); // nothing uploaded
  assert.deepEqual(rec.calls[0].blocks, [
    { text: "From Bunny" },
    { image: `https://cdn/${b}/preview.webp` }, { link: `https://play/${b}` },
    { image: `https://cdn/${a}/preview.webp` }, { link: `https://play/${a}` },
  ]);
  bunny.videos.set(a, 3); // still encoding
  writeFileSync(path, JSON.stringify(spec({ bunny: [{ id: a, title: "First" }], post: { title: "T2", access: "paid" } })));
  await assert.rejects(run(loadJob(path, rec.publishers), bunny as never, { publishers: rec.publishers }), /First: not ready on Bunny \(status 3\)/);
  const bad = (extra: object) => () => loadJob(job(`bad-bunny-${Math.random()}`, ["v.mp4"], spec(extra)));
  assert.throws(bad({ bunny: [{ id: "../videos/x", title: "x" }] }), /"bunny" must be a list/);
  assert.throws(bad({ bunny: [{ id: a, title: "A" }], videos: ["v.mp4"] }), /either local "videos" or "bunny"/);
  assert.throws(bad({ bunny: [{ id: a, title: "A" }, { id: a, title: "A" }] }), /listed twice/);
  saveTemplate({ name: "Files only", needs: "videos", blocks: [{ attachments: true }] });
  assert.throws(bad({ template: "files-only", bunny: [{ id: a, title: "A" }] }), /no local file to attach/);
  deleteTemplate("files-only");
});
