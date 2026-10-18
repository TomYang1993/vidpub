// Templates turn a job's text plus its videos or images into a PostDoc, saved as <job>.post.json. That doc is
// the one thing publishers send. A publisher is (doc, jobPath) => string | Promise<string>; it runs once per job
// and the returned string (a URL or path) is saved in the job state so reruns skip it.
// Add an integration = add a function + a PUBLISHERS entry. Add a layout = add a TEMPLATES entry.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { BrowserContext, Locator } from "playwright";

export type Block = { text: string } | { image: string } | { link: string }; // image: https URL or absolute file path
export type PostDoc = {
  title: string;
  access: string | string[]; // "public" | "patrons" | "paid" | list of tier names
  collection?: string; // Patreon collection (not the Bunny one)
  thumbnail?: string; // image path
  attachments?: string[]; // file paths
  publishNow?: boolean; // patreon_browser: publish right away instead of leaving a draft to review
  blocks: Block[];
};
export type Video = { title: string; url: string; preview?: string }; // preview: animated WebP
export type Template = {
  label: string;
  needs: "videos" | "images";
  build(text: string | undefined, items: { videos?: Video[]; images?: string[] }): Block[];
};
export type Publisher = (doc: PostDoc, jobPath: string) => string | Promise<string>;

const textBlocks = (text?: string): Block[] => (text?.trim() ? [{ text: text.trim() }] : []);
export const TEMPLATES: Record<string, Template> = {
  "video-previews": {
    label: "Video previews: text, then each video's animated preview with its play link",
    needs: "videos",
    build: (text, { videos = [] }) => [
      ...textBlocks(text),
      ...videos.flatMap((v): Block[] => [...(v.preview ? [{ image: v.preview }] : []), { link: v.url }]),
    ],
  },
  "image-gallery": {
    label: "Image gallery: text, then the images, uploaded",
    needs: "images",
    build: (text, { images = [] }) => [...textBlocks(text), ...images.map((image) => ({ image }))],
  },
};

const isUrl = (s: string) => /^https?:\/\//.test(s);

// ponytail: Patreon's API can't create posts (v2 is read-only for posts), so this writes the content
// to the clipboard plus a checklist for the rest. patreon_browser does all of it, but unofficially.
export function patreonManual(doc: PostDoc, jobPath: string) {
  const content = doc.blocks
    .map((b) => ("text" in b ? b.text : "link" in b ? b.link : isUrl(b.image) ? b.image : `Insert image: ${b.image}`))
    .join("\n\n");
  const checklist = [
    `Title: ${doc.title}`,
    doc.thumbnail && `Thumbnail: ${doc.thumbnail}`,
    `Access: ${[doc.access].flat().join(", ")}`,
    doc.collection && `Collection: ${doc.collection}`,
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

// ponytail: Patreon's API can't create posts, so this drives the web editor in Chrome, logged in through
// patreon-login.ts. Unofficial: it breaks when Patreon changes the editor. Selectors were calibrated in Oct 2026
// and all live in `S`. Headed on purpose: Cloudflare blocks headless Chrome. Every field is checked before
// Publish is touched; a failure leaves an unpublished draft plus <job>.patreon-error.png.
export async function patreonBrowser(doc: PostDoc, jobPath: string) {
  if (!doc.access) throw new Error("patreon_browser needs doc.access, so links never go out public by accident");
  const ctx = await openPatreonProfile(false);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const S = {
    title: page.getByRole("textbox", { name: "Title" }),
    content: page.getByRole("textbox", { name: "Text input field for post content" }),
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
  };
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  /** Open a checkbox menu, check pick(names); exclusive also unchecks the rest. Verified, then closed. */
  const setMenu = async (opener: Locator, what: string, pick: (names: string[]) => string[], exclusive: boolean) => {
    await opener.click();
    await S.menuItems.first().waitFor();
    const names = (await S.menuItems.allInnerTexts())
      .map((t) => t.trim().split("\n")[0]) // tiers add a "$x/month · n members" line
      .filter((n) => !n.startsWith("Select all"));
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
    await page.keyboard.press("Escape");
    await S.menuItems.first().waitFor({ state: "detached" }); // so the next menu doesn't see these items
  };

  try {
    if (!(await patreonLoggedIn(ctx))) fail("logged out of Patreon: run node patreon-login.ts");
    await page.bringToFront(); // a covered window stops rendering and stalls clicks
    await page.goto("https://www.patreon.com/posts/new");
    await page.waitForURL(/\/posts\/[^/]*?\d+\/edit/);

    if (doc.thumbnail) {
      await S.imagePost.click();
      const chooser = page.waitForEvent("filechooser");
      await S.browse.click();
      await (await chooser).setFiles(doc.thumbnail);
      await S.thumbnailUploaded.waitFor({ timeout: 300_000 });
    }

    await S.title.fill(doc.title);
    // Paragraphs and links are pasted in one go, with a marker line where each image goes. Each marker then
    // gets its image inserted below it and is removed.
    const images = doc.blocks.flatMap((b) => ("image" in b ? [b.image] : []));
    let n = 0;
    const marked = doc.blocks.map((b) => ("text" in b ? b.text : "link" in b ? b.link : `vidpub-image-${n++}`)).join("\n");
    await S.content.click();
    await S.content.evaluate((el, { text, html }) => { // paste HTML so links stay links
      const data = new DataTransfer();
      data.setData("text/plain", text);
      data.setData("text/html", html);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, { text: marked, html: contentHtml(marked) });
    for (const [i, image] of images.entries()) {
      const marker = S.content.getByText(`vidpub-image-${i}`, { exact: true });
      const count = await S.content.locator("img").count();
      await marker.click();
      await S.addBlock.click();
      await S.imageBlock.click();
      if (isUrl(image)) {
        await S.imageUrl.fill(image); // by URL keeps an animated WebP animated
      } else {
        const chooser = page.waitForEvent("filechooser");
        await S.imageFile.click();
        await (await chooser).setFiles(image);
      }
      await S.imageConfirm.click({ timeout: 10_000 }).catch(() => {}); // a file may insert without it
      await S.content.locator("img").nth(count).waitFor({ timeout: 300_000 });
      await marker.click({ clickCount: 3 });
      await page.keyboard.press("Backspace"); // clear the marker text...
      await page.keyboard.press("Backspace"); // ...and its now-empty paragraph
    }
    if ((await S.title.inputValue()) !== doc.title) fail("title didn't stick");
    const want = doc.blocks.flatMap((b) => // every image and link, in order; uploaded files get Patreon URLs
      "image" in b ? [`img ${isUrl(b.image) ? b.image : "(upload)"}`]
        : "link" in b ? [`a ${b.link}`] : (b.text.match(/https?:\/\/[^\s<]+/g) ?? []).map((u) => `a ${u}`));
    const got = await S.content.evaluate((el) =>
      [...el.querySelectorAll("img[src], a[href]")].map((n) => (n.tagName === "IMG" ? `img ${n.getAttribute("src")}` : `a ${n.getAttribute("href")}`)));
    const same = want.length === got.length && want.every((w, i) => w === got[i] || (w === "img (upload)" && got[i].startsWith("img ")));
    if (!same) fail(`content came out wrong: expected ${want.join(", ")} but got ${got.join(", ")}`);
    if ((await S.content.innerText()).includes("vidpub-image-")) fail("an image marker was left in the content");

    if (doc.attachments?.length) {
      await S.addBlock.click();
      const chooser = page.waitForEvent("filechooser");
      await S.attachmentsBlock.click();
      await (await chooser).setFiles(doc.attachments);
      for (const a of doc.attachments) await S.attachment(basename(a)).waitFor({ timeout: 1_800_000 });
    }

    const access = doc.access;
    if (access === "public" || access === "patrons") {
      await S.free.click();
      await S.freeMore.click();
      const radio = S.freeAudience(access === "public" ? "Public" : "All_Members");
      await radio.locator("xpath=following-sibling::*[@role='button']").click();
      if (!(await radio.isChecked())) fail(`couldn't set access ${access}`);
      await S.freeMoreClose.click();
    } else {
      await S.paid.click();
      if (!(await S.paidMembers.isChecked())) await S.paidMembers.click();
      if (access === "paid") await setMenu(S.tiers, "tier", (all) => all, true);
      else if (Array.isArray(access)) await setMenu(S.tiers, "tier", () => access, true);
      else fail(`doc.access must be "public", "patrons", "paid" or a list of tiers, not ${JSON.stringify(access)}`);
    }
    if (!(await (access === "public" || access === "patrons" ? S.free : S.paid).isChecked())) fail("access didn't stick");

    if (doc.collection) await setMenu(S.collections, "collection", () => [doc.collection!], false);

    await page.waitForTimeout(2000); // let the autosave start, then wait for it to finish
    await S.saving.waitFor({ state: "hidden", timeout: 120_000 });
    await S.saved.waitFor();
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

export const PUBLISHERS: Record<string, Publisher> = { patreon_manual: patreonManual, patreon_browser: patreonBrowser };
