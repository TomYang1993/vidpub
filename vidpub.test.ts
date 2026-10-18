// No network: npm test
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Bunny } from "./bunny.ts";
import { TEMPLATES, contentHtml, type PostDoc } from "./publishers.ts";
import { MAX_ATTEMPTS, buildPost, loadJob, publishPost, run, savePost } from "./vidpub.ts";

const tmp = mkdtempSync(join(tmpdir(), "vidpub-"));
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
  const videos = [{ title: "a", url: "u1", preview: "p1" }, { title: "b", url: "u2" }];
  assert.deepEqual(TEMPLATES["video-previews"].build(undefined, { videos }), [{ image: "p1" }, { link: "u1" }, { link: "u2" }]);
  assert.deepEqual(TEMPLATES["image-gallery"].build("  Hi \n", { images: ["/x.jpg"] }), [{ text: "Hi" }, { image: "/x.jpg" }]);
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
