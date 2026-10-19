// No network: npm test
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listFolder, postProblems, serve, writeJob } from "./server.ts";

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

test("post file shape: paywall, divider, button pass; malformed blocks are refused", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vidpub-pw-")));
  const job = { path: join(dir, "job.json"), videos: [], images: [], publish: [] };
  const doc = { title: "T", access: "paid", blocks: [{ text: "free" }, { paywall: true }, { divider: true },
    { button: { text: "Play", url: "https://p/1", caption: "a" } }, { image: "https://c/1.webp" }, { link: "https://p/1" }] };
  assert.deepEqual(postProblems(dir, job, doc as never), []);
  for (const blocks of [[{ paywall: "yes" }], [{ button: { text: "Play", url: "/etc/hosts" } }], [{ button: { text: "Play", url: "https://p", extra: 1 } }]]) {
    assert.deepEqual(postProblems(dir, job, { ...doc, blocks } as never), ["the post file is malformed: rebuild it"]);
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

/** A GUI server over folders `names` (each with <name>.mp4) in a temp dir, with a Bunny whose uploads wait for
 *  gate(name) and that says "ready" once uploaded. Talks to it like the page does. */
async function queueServer(names: string[], publishers: Record<string, (doc: { title: string }) => string | Promise<string>>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vidpub-q-")));
  const dirs = names.map((n) => (mkdirSync(join(root, n)), writeFileSync(join(root, n, `${n}.mp4`), "x"), join(root, n)));
  writeFileSync(join(root, "ui.json"), JSON.stringify({ folders: dirs }));
  writeFileSync(join(root, "env"), "BUNNY_LIBRARY_ID=1\nBUNNY_API_KEY=k\n");
  const gates = new Map<string, { open: () => void; wait: Promise<void> }>();
  const gate = (n: string) => {
    if (!gates.has(n)) {
      let open!: () => void;
      const wait = new Promise<void>((ok) => (open = ok));
      gates.set(n, { open, wait });
    }
    return gates.get(n)!;
  };
  const uploads: string[] = [];
  const done = new Set<string>();
  const makeHost = () => ({
    findOrCreateCollection: async () => "col", createVideo: async (t: string) => `g-${t}`, deleteVideo: async () => {},
    status: async (g: string) => (done.has(g) ? 4 : null), tusCreate: async () => "tus",
    tusUpload: async (p: string, g: string) => (uploads.push(p), await gate(g.slice(2)).wait, done.add(g), true),
    playUrl: (g: string) => `https://play/${g}`, previewUrl: async () => undefined,
  });
  const { server, url } = await serve({
    recentFile: join(root, "ui.json"), envFile: join(root, "env"), chooseFolder: async () => null,
    makeHost: makeHost as never, publishers: publishers as never, patreonCache: () => null,
  });
  const { origin, searchParams } = new URL(url);
  const headers = { "x-vidpub-token": searchParams.get("t")!, origin, "content-type": "application/json" };
  const post = (path: string, body: object) => fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const queue = async () => { // the first message on /events is the whole queue
    const res = await fetch(`${origin}/events`, { headers });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")).queue as { id: number; dir: string; step: string; state: string; result?: string; log: string[] }[];
  };
  const until = async (ok: (q: Awaited<ReturnType<typeof queue>>) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const q = await queue();
      if (ok(q)) return q;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`queue never got there: ${JSON.stringify((await queue()).map((x) => [x.dir, x.step, x.state]))}`);
  };
  const form = (n: string) => ({ template: "video-previews", videos: [`${n}.mp4`], post: { title: n, access: "paid" }, publish: ["patreon_browser"] });
  const close = () => (server.close(), server.closeAllConnections());
  const upload = (dir: string, name: string, body: string) =>
    fetch(`${origin}/api/thumbnail?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: "POST", headers, body });
  return { dirs, gate, uploads, post, queue, until, form, close, upload };
}

test("queue: one upload at a time, a job is never queued twice, only queued steps cancel, the next one runs after", async () => {
  const { dirs: [a, b, c], gate, uploads, post, queue, until, form, close } = await queueServer(["a", "b", "c"], { patreon_browser: () => "https://draft" });
  try {
    for (const [dir, n] of [[a, "a"], [b, "b"], [c, "c"]]) assert.equal((await post("/api/start", { dir, form: form(n) })).status, 200);
    assert.equal((await post("/api/start", { dir: b, form: form("b") })).status, 409); // already queued
    let q = await queue();
    assert.deepEqual(q.map((x) => x.state), ["running", "queued", "queued"]);
    assert.equal((await post("/api/cancel", { id: q[0].id })).status, 409); // running: can't cancel
    assert.equal((await post("/api/cancel", { id: q[2].id })).status, 200);
    gate("a").open();
    gate("b").open();
    q = await until((q) => q.every((x) => x.state === "done"));
    assert.deepEqual(q.map((x) => [x.dir, x.step]), [[a, "publish"], [b, "publish"]]); // uploaded, built, sent: one entry each
    assert.deepEqual(uploads, [join(a, "a.mp4"), join(b, "b.mp4")]); // in order, never two at once
    assert.ok(existsSync(join(a, "job.json.post.json")) && !existsSync(join(c, "job.json.post.json"))); // c never ran
    // a rebuild from a saved job.json that points outside its folder is refused before anything is queued
    writeFileSync(join(c, "job.json"), JSON.stringify({ ...form("c"), videos: [join(a, "a.mp4")] }));
    const res = await post("/api/start", { dir: c, rebuild: true });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /outside/);
  } finally {
    close();
  }
});

test("queue lanes: one entry goes upload → send; a send runs while another job uploads; logs stay apart", async () => {
  let openSend!: () => void;
  const sendGate = new Promise<void>((ok) => (openSend = ok));
  const sent: string[] = [];
  const publisher = async (doc: { title: string }) => (console.log(`sending ${doc.title}`), await sendGate, sent.push(doc.title), "https://draft");
  const { dirs: [x, y], gate, post, until, form, close } = await queueServer(["x", "y"], { patreon_browser: publisher });
  try {
    gate("x").open();
    assert.equal((await post("/api/start", { dir: x, form: form("x") })).status, 200);
    await until((q) => q[0]?.step === "publish" && q[0].state === "running"); // x uploaded, built, now sending (held)
    assert.equal((await post("/api/start", { dir: y, form: form("y") })).status, 200);
    let q = await until((q) => q.some((s) => s.dir === y && s.state === "running")); // y uploads meanwhile
    assert.deepEqual(q.map((s) => [s.dir, s.step, s.state]), [[x, "publish", "running"], [y, "upload", "running"]]);
    openSend();
    q = await until((q) => q.some((s) => s.dir === x && s.state === "done"));
    assert.equal(q.find((s) => s.dir === x)!.result, "https://draft"); // the link shows on the job
    assert.deepEqual(sent, ["x"]);
    const logOf = (dir: string) => q.find((s) => s.dir === dir)!.log.join("\n");
    assert.match(logOf(x), /sending x/);
    assert.doesNotMatch(logOf(y), /sending x/);
    assert.match(logOf(y), /uploading y\.mp4/);
    gate("y").open();
    await until((q) => q.every((s) => s.state === "done"));
  } finally {
    close();
  }
});

test("thumbnail upload: copied into the job folder under a safe name, images only, never overwrites", async () => {
  const { dirs: [a], close, upload } = await queueServer(["a"], {});
  try {
    const first = await upload(a, "../../cover.png", "one");
    assert.equal(first.status, 200);
    assert.equal((await first.json()).name, "cover.png"); // the path part is dropped: it lands in the folder
    assert.equal(readFileSync(join(a, "cover.png"), "utf8"), "one");
    assert.equal((await (await upload(a, "cover.png", "two")).json()).name, "cover 2.png");
    assert.equal(readFileSync(join(a, "cover.png"), "utf8"), "one");
    assert.equal((await upload(a, "notes.txt", "x")).status, 400);
    assert.equal((await upload(a, ".hidden.png", "x")).status, 400);
    assert.equal((await upload(tmpdir(), "x.png", "x")).status, 403); // not a picked folder
  } finally {
    close();
  }
});
