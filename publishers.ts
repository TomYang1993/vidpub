// Publishers send a PostDoc (built from a template, saved as <job>.post.json; see templates.ts). A publisher is
// (doc, jobPath) => string | Promise<string>; it runs once per job and the returned string (a URL or path) is
// saved in the job state so reruns skip it. Add an integration = add a function + a PUBLISHERS entry.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";

// image: https URL or absolute file path. paywall: Patreon's "Paid access starts here"; what's above it is free.
// button: Patreon's call-to-action block (text and caption have Patreon's length limits). divider: a line.
export type Block =
  | { text: string } | { image: string } | { link: string } | { paywall: true } | { divider: true }
  | { button: { text: string; url: string; caption?: string } };
export const BUTTON_TEXT_MAX = 35;
export const BUTTON_CAPTION_MAX = 140;
export type PostDoc = {
  title: string;
  access: string | string[]; // "public" | "patrons" | "paid" | list of tier names
  collection?: string | string[]; // Patreon collection(s): a post can be in several (not the Bunny one)
  thumbnail?: string; // image path
  attachments?: string[]; // file paths
  publishNow?: boolean; // patreon_browser: publish right away instead of leaving a draft to review
  blocks: Block[];
};
export type Video = { title: string; url: string; preview?: string }; // preview: animated WebP
/** draft: a draft an earlier, interrupted send left, to finish instead of starting another; onDraft: called as soon
 *  as the publisher has a draft, so the job can record it. */
export type PublishOpts = { draft?: string; onDraft?: (url: string) => void };
export type Publisher = (doc: PostDoc, jobPath: string, opts?: PublishOpts) => string | Promise<string>;

/** The post's Patreon collections as a list (a job may give one name or several). */
export const collectionsOf = (doc: Pick<PostDoc, "collection">) => [...new Set([doc.collection ?? []].flat().filter((c) => typeof c === "string" && c.trim()))];

/** Free access can't have a paywall: Patreon only shows one on paid posts. */
export const freeAccess = (access: PostDoc["access"]) => access === "public" || access === "patrons";

const isUrl = (s: string) => /^https?:\/\//.test(s);

// ponytail: Patreon's API can't create posts (v2 is read-only for posts), so this writes the content
// to the clipboard plus a checklist for the rest. patreon_browser does all of it, but unofficially.
export function patreonManual(doc: PostDoc, jobPath: string) {
  const content = doc.blocks
    .map((b) => ("paywall" in b ? "--- Paywall: insert one here (Click to add below → Paywall) ---"
      : "divider" in b ? "--- Divider: insert one here (Click to add below → Divider) ---"
      : "button" in b ? `--- Button: text "${b.button.text}", link ${b.button.url}${b.button.caption ? `, description "${b.button.caption}"` : ""} ---`
      : "text" in b ? b.text : "link" in b ? b.link : isUrl(b.image) ? b.image : `Insert image: ${b.image}`))
    .join("\n\n");
  const checklist = [
    `Title: ${doc.title}`,
    doc.thumbnail && `Thumbnail: ${doc.thumbnail}`,
    `Access: ${[doc.access].flat().join(", ")}`,
    collectionsOf(doc).length && `Collections: ${collectionsOf(doc).join(", ")}`,
    ...(doc.attachments ?? []).map((a) => `Attach: ${a}`),
  ].filter(Boolean).join("\n");
  const out = `${jobPath}.patreon.txt`;
  writeFileSync(out, `${checklist}\n\n${content}\n`);
  spawnSync("pbcopy", { input: content }); // macOS clipboard
  console.log(`\nPatreon post content copied to clipboard (saved with checklist to ${out}).\n${checklist}`);
  return out;
}

export const PATREON_PROFILE = join(homedir(), ".vidpub", "patreon-profile");

/** The profile patreon-login.ts logged in with real Chrome, opened under Playwright. */
export async function openPatreonProfile(headless: boolean) {
  const { chromium } = await import("playwright"); // loaded here so patreon_manual runs and tests never need it
  return chromium.launchPersistentContext(PATREON_PROFILE, {
    channel: "chrome", // same browser that wrote the profile
    ignoreDefaultArgs: ["--use-mock-keychain"], // Chrome encrypts cookies with the real Keychain key; the mock one can't read them
    headless,
    viewport: { width: 1400, height: 1000 }, // the editor's layout depends on width; selectors below are for this one
  });
}

export async function patreonLoggedIn(ctx: BrowserContext) {
  return (await ctx.cookies("https://www.patreon.com")).some((c) => c.name === "session_id");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** Plain text -> editor HTML: one paragraph per line, URLs as links. */
export function contentHtml(text: string) {
  return text.split("\n").map((line) => `<p>${esc(line).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`)}</p>`).join("");
}

const fail = (msg: string): never => {
  throw new Error(msg);
};

/** Patreon's post editor. Selectors were calibrated in Oct 2026 and all live here. */
function editor(page: Page) {
  const content = page.getByRole("textbox", { name: "Text input field for post content" });
  const S = {
    title: page.getByRole("textbox", { name: "Title" }),
    content,
    imagePost: page.getByRole("button", { name: "Image", exact: true }), // thumbnail = image post's cover
    imageBlock: page.getByRole("menuitem", { name: "Image", exact: true }), // inline image, under "Click to add below"
    imageUrl: page.getByPlaceholder("Type or paste image URL"), // by URL keeps a WebP animated; a file upload doesn't
    imageFile: page.getByRole("button", { name: "Select image file" }),
    imageConfirm: page.getByRole("button", { name: "Confirm", exact: true }),
    browse: page.getByRole("button", { name: "Browse", exact: true }),
    thumbnailUploaded: page.getByRole("button", { name: "Add image" }),
    addBlock: page.getByRole("button", { name: "Click to add below" }),
    attachmentsBlock: page.getByRole("menuitem", { name: "Attachments" }),
    attachment: (name: string) => page.getByRole("link", { name, exact: true }),
    free: page.getByRole("radio", { name: "Free access" }),
    paid: page.getByRole("radio", { name: /^Paid access/ }),
    freeMore: page.getByRole("button", { name: "More options" }),
    freeAudience: (value: string) => page.locator(`input[type=radio][value="${value}"]`), // Public | All_Members
    freeMoreClose: page.getByRole("button", { name: "Close", exact: true }),
    paidMembers: page.getByRole("checkbox", { name: "Toggle tier selection" }),
    tiers: page.getByRole("button", { name: "Select tiers" }),
    collections: page.getByRole("button", { name: /creator.s collections/ }),
    menuItems: page.getByRole("menuitemcheckbox"),
    menuItem: (name: string) => page.getByRole("menuitemcheckbox", { name, exact: true }),
    saving: page.getByText(/^Saving/), // "Saving.."
    saved: page.getByText("Saved", { exact: true }),
    publish: page.getByRole("button", { name: "Publish", exact: true }),
    paywallBlock: page.getByRole("menuitem", { name: "Paywall", exact: true }), // under "Click to add below"
    dividerBlock: page.getByRole("menuitem", { name: "Divider", exact: true }),
    buttonBlock: page.getByRole("menuitem", { name: "Button", exact: true }), // opens an "Edit button" side panel
    buttonCaption: page.getByPlaceholder("Your button description"),
    buttonText: page.getByPlaceholder("Click here"),
    buttonLink: page.getByPlaceholder("Add link"),
    // the divider in the content; a page-wide count also catches the drag ghost Patreon shows after clicking one
    paywall: content.getByRole("button", { name: "Draggable paywall" }),
  };
  /** Open a checkbox menu and list its options (tiers, collections). */
  const menuNames = async (opener: Locator) => {
    await opener.click();
    await S.menuItems.first().waitFor();
    return (await S.menuItems.allInnerTexts())
      .map((t) => t.trim().split("\n")[0]) // tiers add a "$x/month · n members" line
      .filter((n) => !n.startsWith("Select all"));
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await S.menuItems.first().waitFor({ state: "detached" }); // so the next menu doesn't see these items
  };
  /** Open a checkbox menu, check pick(names); exclusive also unchecks the rest. Verified, then closed. */
  const setMenu = async (opener: Locator, what: string, pick: (names: string[]) => string[], exclusive: boolean) => {
    const names = await menuNames(opener);
    const want = pick(names);
    const missing = want.filter((w) => !names.includes(w));
    if (missing.length) fail(`no Patreon ${what} named ${missing.join(", ")}; there are: ${names.join(", ")}`);
    const isOn = async (n: string) => (await S.menuItem(n).getAttribute("aria-checked")) === "true";
    for (const n of want) if (!(await isOn(n))) await S.menuItem(n).click(); // add first: never zero selected
    for (const n of names) if (exclusive && !want.includes(n) && (await isOn(n))) await S.menuItem(n).click();
    for (const n of names) {
      const on = await isOn(n);
      if (want.includes(n) ? !on : exclusive && on) fail(`couldn't ${on ? "uncheck" : "check"} Patreon ${what} ${n}`);
    }
    await closeMenu();
  };
  /** Close announcement popups Patreon shows over the page (e.g. "New: now you can recommend…"). */
  const dismissPopups = async () => {
    for (let i = 0; i < 3 && (await page.getByRole("dialog").first().isVisible().catch(() => false)); i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  };
  return { S, menuNames, closeMenu, setMenu, dismissPopups };
}

// ponytail: Patreon's API can't create posts, so this drives the web editor in Chrome, logged in through
// patreon-login.ts. Unofficial: it breaks when Patreon changes the editor. Selectors were calibrated in Oct 2026
// and all live in editor(). Headed on purpose: Cloudflare blocks headless Chrome. Every field is checked before
// Publish is touched; a failure leaves an unpublished draft plus <job>.patreon-error.png.
export async function patreonBrowser(doc: PostDoc, jobPath: string, opts: PublishOpts = {}) {
  if (!doc.access) throw new Error("patreon_browser needs doc.access, so links never go out public by accident");
  const ctx = await openPatreonProfile(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const { S, setMenu, dismissPopups } = editor(page);
  const open = async (url: string) => {
    await page.goto(url);
    await page.waitForURL(/\/posts\/[^/]*?\d+\/edit/, { timeout: 30_000 });
    await S.title.waitFor();
  };
  /** Let Patreon's autosave start, then wait until it says Saved. */
  const saveNow = async () => {
    await page.waitForTimeout(2000);
    await S.saving.waitFor({ state: "hidden", timeout: 120_000 });
    await S.saved.waitFor();
  };
  try {
    if (!(await patreonLoggedIn(ctx))) fail("logged out of Patreon: run node patreon-login.ts");
    await page.bringToFront(); // a covered window stops rendering and stalls clicks
    // An earlier, interrupted send of this job left a draft: finish that one instead of starting another (and skip the
    // attachments it already has). If it's gone (deleted), start fresh.
    const resumed = !!opts.draft && (await open(opts.draft).then(() => true, () => false));
    if (!resumed) await open("https://www.patreon.com/posts/new");
    opts.onDraft?.(page.url()); // recorded now, so an interrupted send can be found and finished
    await dismissPopups();
    console.log(resumed ? `continuing draft ${page.url()}` : `new draft ${page.url()}`);

    if (doc.thumbnail && resumed) console.log("thumbnail: left as it is on the draft");
    if (doc.thumbnail && !resumed) {
      await S.imagePost.click();
      const chooser = page.waitForEvent("filechooser");
      await S.browse.click();
      await (await chooser).setFiles(doc.thumbnail);
      await S.thumbnailUploaded.waitFor({ timeout: 300_000 });
    }

    // Settings first: access (switching to paid makes Patreon add its own paywall at the top, and switching to free
    // removes every paywall, so it has to happen before ours goes in) and collections, saved before anything slow,
    // so an interrupted upload can't leave the post without them. Both are applied again at the end.
    const access = doc.access;
    const paid = !freeAccess(access);
    if (!paid && doc.blocks.some((b) => "paywall" in b)) fail(`a paywall needs paid access, not ${access}`);
    const applyAccess = async () => {
      if (!paid) {
        if (!(await S.free.isChecked())) await S.free.click();
        await S.freeMore.click();
        const radio = S.freeAudience(access === "public" ? "Public" : "All_Members");
        if (!(await radio.isChecked())) await radio.locator("xpath=following-sibling::*[@role='button']").click();
        if (!(await radio.isChecked())) fail(`couldn't set access ${access}`);
        await S.freeMoreClose.click();
      } else {
        if (!(await S.paid.isChecked())) await S.paid.click();
        if (!(await S.paidMembers.isChecked())) await S.paidMembers.click();
        if (access === "paid") await setMenu(S.tiers, "tier", (all) => all, true);
        else if (Array.isArray(access)) await setMenu(S.tiers, "tier", () => access, true);
        else fail(`doc.access must be "public", "patrons", "paid" or a list of tiers, not ${JSON.stringify(access)}`);
      }
      if (!(await (paid ? S.paid : S.free).isChecked())) fail("access didn't stick");
    };
    const collections = collectionsOf(doc);
    const applyCollections = async () => {
      if (collections.length) await setMenu(S.collections, "collection", () => collections, true);
    };
    await applyAccess();
    await applyCollections();
    await S.title.fill(doc.title);
    await saveNow();
    console.log(`access${collections.length ? " and collections" : ""} set and saved`);

    if (resumed) { // start the body over: the interrupted send may have left part of it
      await S.content.click();
      await page.keyboard.press("Meta+a");
      await page.keyboard.press("Backspace");
    }
    // A paid post always has exactly one paywall; without one in the doc it goes on top, so everything is locked.
    const blocks = paid && !doc.blocks.some((b) => "paywall" in b) ? [{ paywall: true } as const, ...doc.blocks] : doc.blocks;
    // Paragraphs and links are pasted in one go, with a marker line where each other block goes. Markers are then
    // replaced bottom-up: each gets its block inserted below it and is removed. Bottom-up, the line above a marker is
    // never an inserted block, so removing the marker's empty line can't take that block with it.
    const marker = (i: number) => S.content.getByText(`vidpub-block-${i}`, { exact: true });
    const marked = blocks.map((b, i) => ("text" in b ? b.text : "link" in b ? b.link : `vidpub-block-${i}`)).join("\n");
    await S.content.click();
    await S.content.evaluate((el, { text, html }) => { // paste HTML so links stay links
      const data = new DataTransfer();
      data.setData("text/plain", text);
      data.setData("text/html", html);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, { text: marked, html: contentHtml(marked) });
    // Patreon's own paywall (put in when access went paid) goes wherever the paste left it; ours replaces it
    for (let i = 0; i < 5 && (await S.paywall.count()); i++) {
      await S.paywall.first().click();
      await page.keyboard.press("Backspace");
    }
    if (await S.paywall.count()) fail("couldn't remove Patreon's default paywall");
    /** Wait until there's one more of these than before: the inserted block landed. */
    const grows = async (sel: string, before: number, timeout = 30_000) => {
      for (const end = Date.now() + timeout; (await S.content.locator(sel).count()) <= before;) {
        if (Date.now() > end) fail(`a block didn't appear (${sel})`);
        await page.waitForTimeout(250);
      }
    };
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if ("text" in b || "link" in b) continue;
      const sel = "image" in b ? "img" : "divider" in b ? "hr" : "button" in b ? "[data-cta]" : '[aria-label="Draggable paywall"]';
      const before = await S.content.locator(sel).count();
      await marker(i).click();
      await S.addBlock.click();
      if ("image" in b) {
        await S.imageBlock.click();
        if (isUrl(b.image)) {
          await S.imageUrl.fill(b.image); // by URL keeps an animated WebP animated
        } else {
          const chooser = page.waitForEvent("filechooser");
          await S.imageFile.click();
          await (await chooser).setFiles(b.image);
        }
        await S.imageConfirm.click({ timeout: 10_000 }).catch(() => {}); // a file may insert without it
        await grows(sel, before, 300_000);
      } else if ("divider" in b) {
        await S.dividerBlock.click();
        await grows(sel, before);
      } else if ("button" in b) {
        await S.buttonBlock.click();
        await S.buttonText.fill(b.button.text);
        await S.buttonLink.fill(b.button.url);
        if (b.button.caption) await S.buttonCaption.fill(b.button.caption);
        await grows(sel, before);
      } else {
        await S.paywallBlock.click();
        await grows(sel, before);
      }
      await marker(i).click({ clickCount: 3 }); // also closes the button panel
      await page.keyboard.press("Backspace"); // clear the marker text...
      await page.keyboard.press("Backspace"); // ...and its now-empty paragraph
    }
    if ((await S.title.inputValue()) !== doc.title) fail("title didn't stick");
    const want = blocks.flatMap((b) => // every non-text block and link, in order; uploaded files get Patreon URLs
      "paywall" in b ? ["paywall"] : "divider" in b ? ["hr"] : "button" in b ? [`button ${b.button.text} ${b.button.url} ${b.button.caption ?? ""}`]
        : "image" in b ? [`img ${isUrl(b.image) ? b.image : "(upload)"}`]
        : "link" in b ? [`a ${b.link}`] : (b.text.match(/https?:\/\/[^\s<]+/g) ?? []).map((u) => `a ${u}`));
    const got = await S.content.evaluate((el) =>
      [...el.querySelectorAll('img[src], a[href], hr, [data-cta], [aria-label="Draggable paywall"]')].map((n) =>
        n.tagName === "IMG" ? `img ${n.getAttribute("src")}` : n.tagName === "A" ? `a ${n.getAttribute("href")}` : n.tagName === "HR" ? "hr"
          : n.hasAttribute("data-cta") ? `button ${n.getAttribute("data-button_text")} ${n.getAttribute("data-button_link")} ${n.getAttribute("data-caption") ?? ""}`
          : "paywall"));
    const same = want.length === got.length && want.every((w, i) => w === got[i] || (w === "img (upload)" && got[i].startsWith("img ")));
    if (!same) fail(`content came out wrong: expected ${want.join(", ")} but got ${got.join(", ")}`);
    if ((await S.content.innerText()).includes("vidpub-block-")) fail("a marker was left in the content");

    const todo: string[] = []; // attachments the draft doesn't have yet (a resumed draft may have some)
    for (const a of doc.attachments ?? []) if (!(await S.attachment(basename(a)).count())) todo.push(a);
    if (todo.length < (doc.attachments?.length ?? 0)) console.log(`${doc.attachments!.length - todo.length} attachments are already on the draft`);
    if (todo.length) { // Patreon puts them in their own section below the post
      console.log(`uploading ${todo.length} attachment${todo.length === 1 ? "" : "s"} to Patreon`);
      await S.addBlock.click();
      const chooser = page.waitForEvent("filechooser");
      await S.attachmentsBlock.click();
      await (await chooser).setFiles(todo);
      // Big videos take a while. Patreon's limits aren't documented anywhere we could read, so a refusal is caught
      // from its own message instead of waiting out the timeout.
      const refused = page.getByText(/too large|exceeds|maximum file size|upload failed|couldn.t upload|could not upload|unsupported file/i).first();
      for (const [i, a] of todo.entries()) {
        // each side settles on its own, so the one that loses the race can't throw later, after Chrome closes
        const done = S.attachment(basename(a)).waitFor({ timeout: 3 * 3600_000 }).then(() => "", () => "it didn't finish uploading in 3 hours");
        const no = refused.waitFor({ timeout: 3 * 3600_000 }).then(async () => (await refused.innerText().catch(() => "refused")).trim(), () => new Promise<string>(() => {}));
        const why = await Promise.race([done, no]);
        if (why) fail(`Patreon didn't take attachment ${basename(a)}: ${why}`);
        console.log(`  attached ${basename(a)} (${i + 1}/${todo.length})`);
      }
    }

    await applyAccess(); // again: hours may have passed, and nothing may have dropped them
    await applyCollections();
    if (await S.paywall.count() !== (paid ? 1 : 0)) fail(`expected ${paid ? "one paywall" : "no paywall"}, found ${await S.paywall.count()}`);
    await saveNow();
    // Patreon allows one editor per post; if it was opened elsewhere meanwhile, this tab's changes may not have stuck
    const elsewhere = page.getByText(/another (tab|window|device|browser)|opened elsewhere|editing this post (in|on)/i).first();
    if (await elsewhere.isVisible().catch(() => false)) {
      fail(`Patreon says the post is open elsewhere ("${(await elsewhere.innerText()).trim()}"): close it there, then Send again`);
    }
    const id = page.url().match(/(\d+)\/edit/)![1];
    if (!doc.publishNow) {
      console.log(`Patreon draft saved: ${page.url()} (review, then publish)`);
      return page.url();
    }
    await S.publish.click();
    await page.waitForURL((u) => !u.pathname.endsWith("/edit"), { timeout: 120_000 });
    console.log(`Patreon post published: https://www.patreon.com/posts/${id}`);
    return `https://www.patreon.com/posts/${id}`;
  } catch (e) {
    const shot = `${jobPath}.patreon-error.png`;
    await page.screenshot({ path: shot, timeout: 10_000 }).catch(() => {});
    throw new Error(`patreon_browser: ${(e as Error).message.split("\n")[0]}\n  page: ${page.url()}\n  screenshot: ${shot}`);
  } finally {
    await ctx.close();
  }
}

export type PatreonOptions = { tiers: string[]; collections: string[]; read: string; draft?: string };
export const PATREON_OPTIONS = join(homedir(), ".vidpub", "patreon.json");
export const readPatreonCache = (path = PATREON_OPTIONS): PatreonOptions | null =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
const SCRATCH_TITLE = "vidpub scratch: reads your tiers and collections. Don't publish.";

/** Read your tier and collection names from the post editor (the API has no collections). Reuses one scratch draft,
 *  remembered in the cache, so a refresh doesn't leave a new draft behind every time. */
export async function readPatreonOptions(): Promise<PatreonOptions> {
  const ctx = await openPatreonProfile(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const { S, menuNames, closeMenu, dismissPopups } = editor(page);
  const open = async (url: string) => {
    await page.goto(url);
    await page.waitForURL(/\/posts\/[^/]*?\d+\/edit/, { timeout: 30_000 });
    await S.title.waitFor({ timeout: 30_000 });
    await dismissPopups();
  };
  try {
    if (!(await patreonLoggedIn(ctx))) fail("logged out of Patreon: run node patreon-login.ts");
    await page.bringToFront();
    const prev = readPatreonCache()?.draft;
    await (prev ? open(prev).catch(() => open("https://www.patreon.com/posts/new")) : open("https://www.patreon.com/posts/new"));
    if ((await S.title.inputValue()) !== SCRATCH_TITLE) await S.title.fill(SCRATCH_TITLE);
    await S.paid.click();
    if (!(await S.paidMembers.isChecked())) await S.paidMembers.click();
    const tiers = await menuNames(S.tiers);
    await closeMenu();
    let collections: string[] = [];
    try {
      collections = await menuNames(S.collections);
      await closeMenu();
    } catch {
      await page.keyboard.press("Escape"); // no collections yet: the menu stays empty
    }
    await page.waitForTimeout(2000);
    await S.saving.waitFor({ state: "hidden", timeout: 60_000 });
    const out: PatreonOptions = { tiers, collections, read: new Date().toISOString(), draft: page.url() };
    mkdirSync(dirname(PATREON_OPTIONS), { recursive: true });
    writeFileSync(PATREON_OPTIONS, `${JSON.stringify(out, null, 2)}\n`);
    return out;
  } finally {
    await ctx.close();
  }
}

export const PUBLISHERS: Record<string, Publisher> = { patreon_manual: patreonManual, patreon_browser: patreonBrowser };
