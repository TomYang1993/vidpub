// No network: npm test
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, listFolder, postProblems, writeJob } from "./server.ts";

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
