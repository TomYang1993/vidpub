// No network: npm test
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, listFolder, postProblems, serve, writeJob } from "./server.ts";

process.env.VIDPUB_TEMPLATES = mkdtempSync(join(tmpdir(), "vidpub-tpl-")); // never the user's own saved templates

test("GUI job: saved as a CLI job.json and read back; bad input lists every problem and keeps the saved job", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vidpub-ui-")));
  for (const f of ["02.mp4", "01.mp4", "cover.jpg", "notes.pdf"]) writeFileSync(join(dir, f), "x");
  const publishers = { patreon_browser: () => "draft" };
  const form = {
    template: "video-previews",
    videos: ["02.mp4", "01.mp4"],
    collection: " Oct ",
    post: { title: " Oct ", text: "This month:", thumbnail: "cover.jpg", access: "public", attachments: ["notes.pdf"] },
    publish: ["patreon_browser"],
  };
  const job = writeJob(dir, form, publishers);
  assert.deepEqual(job.videos, [join(dir, "02.mp4"), join(dir, "01.mp4")]);
  const saved = readFileSync(join(dir, "job.json"), "utf8");
  assert.deepEqual(JSON.parse(saved), { ...form, collection: "Oct", post: { ...form.post, title: "Oct" } });
  assert.deepEqual(listFolder(dir).job, { ...JSON.parse(saved), images: [] }); // what the page gets back when the folder is reopened

  assert.throws(() => writeJob(dir, { videos: ["../02.mp4"] }, publishers), /not files in/);
  assert.throws(() => writeJob(dir, { template: "video-previews", videos: ["01.mp4", "gone.mp4"], post: { title: "" }, publish: ["patreon_browser"] }, publishers),
    (e: Error) => ["missing: " + join(dir, "gone.mp4"), "post.title", "post.access"].every((s) => e.message.includes(s)));
  assert.throws(() => writeJob(dir, { template: "video-previews", videos: ["01.mp4"], post: { title: "t", access: "public" } }, publishers), /pick where to publish/);
  assert.equal(readFileSync(join(dir, "job.json"), "utf8"), saved);
  assert.ok(!existsSync(join(dir, ".job.draft.json")));
});

test("preview edits change only the title and text blocks; emptied text is dropped", () => {
  const doc = { title: "Oct", access: "public", blocks: [{ text: "Hi" }, { image: "https://cdn/p.webp" }, { link: "https://play/1" }, { text: "Bye" }] };
  const body = { title: " October ", texts: [" Hello ", ""], blocks: [{ image: "/etc/passwd" }] }; // blocks: ignored
  const edited = applyEdits(doc, body);
  assert.deepEqual(edited, { ...doc, title: "October", blocks: [{ text: "Hello" }, { image: "https://cdn/p.webp" }, { link: "https://play/1" }] });
  assert.deepEqual(applyEdits(doc, { title: 5, texts: "nope" }), doc);
});

test("preview paywall: placed, moved, removed; a malformed one is refused", () => {
  const doc = { title: "T", access: "paid", blocks: [{ text: "free" }, { image: "https://c/1.webp" }, { link: "https://p/1" }] };
  const placed = applyEdits(doc, { paywall: 2 });
  assert.deepEqual(placed.blocks.map((b) => Object.keys(b)[0]), ["text", "image", "paywall", "link"]);
  assert.deepEqual(applyEdits(placed, { paywall: 0 }).blocks[0], { paywall: true }); // moved, still one
  assert.equal(applyEdits(placed, { paywall: 0 }).blocks.filter((b) => "paywall" in b).length, 1);
  assert.deepEqual(applyEdits(placed, { paywall: null }).blocks, doc.blocks);
  assert.deepEqual(applyEdits(placed, {}).blocks, placed.blocks); // absent: unchanged
  assert.deepEqual(applyEdits(doc, { paywall: 99 }).blocks.at(-1), { paywall: true }); // clamped
  // position counts the blocks as shown, before an emptied text block drops out
  assert.deepEqual(applyEdits(doc, { texts: [""], paywall: 1 }).blocks.map((b) => Object.keys(b)[0]), ["paywall", "image", "link"]);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vidpub-pw-")));
  const job = { path: join(dir, "job.json"), videos: [], images: [], publish: [] };
  assert.deepEqual(postProblems(dir, job, placed), []);
  assert.deepEqual(postProblems(dir, job, { ...doc, blocks: [{ paywall: "yes" }] } as never), ["the post file is malformed: rebuild it"]);
  const ok = { ...doc, blocks: [{ divider: true }, { button: { text: "Play", url: "https://p/1", caption: "a" } }] };
  assert.deepEqual(postProblems(dir, job, ok as never), []);
  for (const button of [{ text: "Play", url: "/etc/hosts" }, { text: "Play", url: "https://p", extra: 1 }]) {
    assert.deepEqual(postProblems(dir, job, { ...doc, blocks: [{ button }] } as never), ["the post file is malformed: rebuild it"]);
  }
});

test("a downloaded folder can't make Send upload files from elsewhere, or make the GUI write through a symlink", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vidpub-ui-")));
  const elsewhere = join(realpathSync(tmpdir()), `vidpub-secret-${process.pid}.txt`);
  writeFileSync(elsewhere, "secret");
  writeFileSync(join(dir, "a.png"), "x");
  symlinkSync(elsewhere, join(dir, "link.pdf"));
  const job = { path: join(dir, "job.json"), videos: [], images: [join(dir, "a.png")], publish: [], post: { title: "t", access: "public", attachments: [join(dir, "link.pdf")] } };
  const doc = { title: "t", access: "public", attachments: [elsewhere], blocks: [{ image: join(dir, "a.png") }, { image: "/etc/hosts" }, { image: "https://cdn/x.webp" }] };
  assert.deepEqual(postProblems(dir, job, doc), [join(dir, "link.pdf"), elsewhere, "/etc/hosts"].map((p) => `outside ${dir}: ${p}`));
  symlinkSync(join(dir, "not-yet"), join(dir, "dangling.png"));
  assert.deepEqual(postProblems(dir, { ...job, post: undefined }, { ...doc, attachments: [], blocks: [{ image: join(dir, "dangling.png") }] }),
    [`missing: ${join(dir, "dangling.png")}`]);
  const sneaky = JSON.parse(JSON.stringify({ ...doc, attachments: "/etc/hosts", blocks: [] })); // raw JSON, any shape
  assert.deepEqual(postProblems(dir, { ...job, post: undefined }, sneaky), ["the post file is malformed: rebuild it"]);

  symlinkSync(elsewhere, join(dir, ".job.draft.json")); // planted
  writeJob(dir, { template: "image-gallery", images: ["a.png"], post: { title: "t", access: "public" }, publish: ["p"] }, { p: () => "" });
  assert.equal(readFileSync(elsewhere, "utf8"), "secret");
});

test("queue: one step at a time, a job is never queued twice, only queued steps cancel, the next one runs after", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vidpub-q-")));
  const [a, b, c] = ["a", "b", "c"].map((n) => (mkdirSync(join(root, n)), writeFileSync(join(root, n, `${n}.mp4`), "x"), join(root, n)));
  writeFileSync(join(root, "ui.json"), JSON.stringify({ folders: [a, b, c] }));
  writeFileSync(join(root, "env"), "BUNNY_LIBRARY_ID=1\nBUNNY_API_KEY=k\n");
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok)); // holds the first upload until the checks are done
  const uploads: string[] = [];
  const done = new Set<string>(); // Bunny says "ready" once a video is uploaded
  const makeHost = () => ({
    findOrCreateCollection: async () => "col", createVideo: async (t: string) => `g-${t}`, deleteVideo: async () => {},
    status: async (g: string) => (done.has(g) ? 4 : null), tusCreate: async () => "tus",
    tusUpload: async (p: string, g: string) => (uploads.push(p), await gate, done.add(g), true),
    playUrl: (g: string) => `https://play/${g}`, previewUrl: async () => undefined,
  });
  const { server, url } = await serve({
    recentFile: join(root, "ui.json"), envFile: join(root, "env"), chooseFolder: async () => null,
    makeHost: makeHost as never, publishers: { patreon_browser: () => "https://draft" }, patreonCache: () => null,
  });
  const { origin, searchParams } = new URL(url);
  const headers = { "x-vidpub-token": searchParams.get("t")!, origin, "content-type": "application/json" };
  const post = (path: string, body: object) => fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const queue = async () => { // the first message on /events is the whole queue
    const res = await fetch(`${origin}/events`, { headers });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")).queue as { id: number; dir: string; state: string }[];
  };
  const form = (n: string) => ({ template: "video-previews", videos: [`${n}.mp4`], post: { title: n, access: "paid" }, publish: ["patreon_browser"] });
  try {
    for (const [dir, n] of [[a, "a"], [b, "b"], [c, "c"]]) assert.equal((await post("/api/start", { dir, form: form(n) })).status, 200);
    assert.equal((await post("/api/start", { dir: b, form: form("b") })).status, 409); // already queued
    let q = await queue();
    assert.deepEqual(q.map((x) => x.state), ["running", "queued", "queued"]);
    assert.equal((await post("/api/cancel", { id: q[0].id })).status, 409); // running: can't cancel
    assert.equal((await post("/api/cancel", { id: q[2].id })).status, 200);
    assert.equal((await post("/api/post/save", { dir: a, title: "x" })).status, 400); // nothing built yet
    release();
    for (let i = 0; i < 100 && (q = await queue()).some((x) => x.state !== "done"); i++) await new Promise((ok) => setTimeout(ok, 20));
    assert.deepEqual(q.map((x) => [x.dir, x.state]), [[a, "done"], [b, "done"]]);
    assert.deepEqual(uploads, [join(a, "a.mp4"), join(b, "b.mp4")]); // in order, never two at once
    assert.ok(existsSync(join(a, "job.json.post.json")) && !existsSync(join(c, "job.json.post.json"))); // c never ran
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
