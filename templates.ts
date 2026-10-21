// Templates: a post layout as data. A layout is a list of blocks and repeat sections; a repeat section's blocks
// come out once per video (or image), in order. Blocks use {variables}: {text} and {count} anywhere; inside a
// repeat, {name} and {n} plus {preview} {play} (videos) or {file} (images).
// { attachments: true } attaches the job's files themselves to the post. Patreon always shows attachments in their own
// section below the post, so it isn't a position in the layout: it's kept last. A template that never uses {preview}
// or {play} doesn't need Bunny, so its videos aren't uploaded there.
// Built-ins live here; saved ones are ~/.vidpub/templates/<id>.json and override a built-in with the same id.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUTTON_CAPTION_MAX, BUTTON_TEXT_MAX, type Block, type Video } from "./publishers.ts";

export type Item = Block | { repeat: Block[] } | { attachments: true };
export type Template = {
  id: string;
  name: string;
  needs: "videos" | "images"; // what repeat sections repeat over
  blocks: Item[];
  builtin?: boolean;
};

export const templateDir = () => process.env.VIDPUB_TEMPLATES ?? join(homedir(), ".vidpub", "templates");

export const BUILTIN: Template[] = [
  {
    id: "video-previews", name: "Video previews", needs: "videos", builtin: true,
    blocks: [{ text: "{text}" }, { repeat: [{ image: "{preview}" }, { link: "{play}" }] }],
  },
  {
    id: "image-gallery", name: "Image gallery", needs: "images", builtin: true,
    blocks: [{ text: "{text}" }, { repeat: [{ image: "{file}" }] }],
  },
];

const EACH_VARS = { videos: ["name", "n", "preview", "play"], images: ["name", "n", "file"] };
const str = (x: unknown): x is string => typeof x === "string";
// images, links and buttons end up as URLs; a local path would make a publisher upload that file
const urlOk = (v: string, inRepeat: boolean) => /^https:\/\/\S+$/.test(v) || (inRepeat && /^\{play\}/.test(v));

/** Check one block; pushes problems, returns the clean block or null. */
function checkBlock(b: any, at: string, vars: string[], inRepeat: boolean, problems: string[]): Block | null {
  const keys = b && typeof b === "object" ? Object.keys(b) : [];
  const [key] = keys;
  const bad = (msg: string) => (problems.push(`${at}: ${msg}`), null);
  if (keys.length !== 1 || !["text", "image", "link", "paywall", "divider", "button"].includes(key)) {
    return bad("one of text, image, link, button, divider, paywall, repeat");
  }
  const varsIn = (v: string) => {
    for (const [, k] of v.matchAll(/\{(\w+)\}/g)) if (!vars.includes(k)) problems.push(`${at}: {${k}} isn't available here (have ${vars.map((x) => `{${x}}`).join(" ")})`);
  };
  if (key === "paywall" || key === "divider") {
    if (b[key] !== true) return bad(`${key} is true`);
    if (key === "paywall" && inRepeat) return bad("a paywall can't repeat: put it outside the repeat section");
    return { [key]: true } as Block;
  }
  if (key === "button") {
    const { text, url, caption } = b.button ?? {};
    if (!str(text) || !text.trim() || !str(url) || (caption !== undefined && !str(caption))) return bad("a button has text and a url (and maybe a caption)");
    if (!urlOk(url, inRepeat)) problems.push(`${at}: a button's url starts with https://${inRepeat ? " or {play}" : ""}`);
    for (const v of [text, url, caption ?? ""]) varsIn(v);
    return { button: { text, url, ...(caption?.trim() ? { caption } : {}) } };
  }
  const v = b[key];
  if (!str(v) || v.length > 5000) return bad(`${key} is text up to 5000 characters`);
  varsIn(v);
  if (key === "image" && !(urlOk(v, false) || (inRepeat && (v === "{preview}" || v === "{file}")))) problems.push(`${at}: an image is an https:// URL${inRepeat ? ", {preview} or {file}" : ""}`);
  if (key === "link" && !urlOk(v, inRepeat)) problems.push(`${at}: a link starts with https://${inRepeat ? " or {play}" : ""}`);
  return { [key]: v } as Block;
}

/** Check a template from a file or the GUI. Lists every problem; returns a clean copy. */
export function checkTemplate(raw: any): Template {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") throw new Error("a template is a JSON object");
  const name = str(raw.name) ? raw.name.trim() : "";
  if (!name || name.length > 80) problems.push("name: 1 to 80 characters");
  const id = str(raw.id) && raw.id ? raw.id : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (name && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) problems.push("name needs a letter or digit");
  const needs = raw.needs;
  if (needs !== "videos" && needs !== "images") problems.push(`needs: "videos" or "images"`);
  if (!Array.isArray(raw.blocks)) problems.push("blocks: a list of blocks and repeat sections");
  const outer = ["text", "count"];
  const inner = [...outer, ...(EACH_VARS[needs as "videos"] ?? [])];
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).flatMap((b: any, i: number): Item[] => {
    const at = `block ${i + 1}`;
    if (b && typeof b === "object" && "attachments" in b) {
      if (Object.keys(b).length !== 1 || b.attachments !== true) return problems.push(`${at}: attachments is true`), [];
      return [{ attachments: true as const }];
    }
    if (b && typeof b === "object" && "repeat" in b) {
      if (Object.keys(b).length !== 1 || !Array.isArray(b.repeat) || !b.repeat.length) return problems.push(`${at}: a repeat section has blocks`), [];
      const each = b.repeat.flatMap((x: any, j: number) => {
        if (x && typeof x === "object" && "repeat" in x) return problems.push(`${at}: repeat sections can't nest`), [];
        if (x && typeof x === "object" && "attachments" in x) return problems.push(`${at}: attachments are the post's files: add them outside the repeat section`), [];
        return [checkBlock(x, `${at}, repeat block ${j + 1}`, inner, true, problems)].filter((y): y is Block => !!y);
      });
      return [{ repeat: each }];
    }
    const block = checkBlock(b, at, outer, false, problems);
    return block ? [block] : [];
  });
  if (!blocks.some((b: Item) => "repeat" in b || "attachments" in b)) problems.push(`add a repeat section or attachments, or the ${needs ?? "files"} won't be in the post`);
  if (blocks.filter((b: Item) => "attachments" in b).length > 1) problems.push("attachments only once");
  if (blocks.filter((b: Item) => "paywall" in b).length > 1) problems.push("only one paywall per post");
  if (problems.length) throw new Error(problems.join("\n"));
  const last = (b: Item) => ("attachments" in b ? 1 : 0); // where Patreon shows them
  return { id, name, needs, blocks: [...blocks].sort((a: Item, z: Item) => last(a) - last(z)) };
}

/** Whether the template attaches the job's files to the post. */
export const attaches = (t: Template) => t.blocks.some((b) => "attachments" in b);
/** Whether the template shows anything from Bunny ({preview}, {play}); if not, videos aren't uploaded there. */
export const usesBunny = (t: Template) => /\{(preview|play)\}/.test(JSON.stringify(t.blocks));

/** Built-ins plus saved templates, by id. A broken saved file is skipped with a warning, never fatal. */
export function loadTemplates(dir = templateDir()): Record<string, Template> {
  const all: Record<string, Template> = Object.fromEntries(BUILTIN.map((t) => [t.id, t]));
  if (!existsSync(dir)) return all;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const t = checkTemplate({ ...JSON.parse(readFileSync(join(dir, f), "utf8")), id: f.slice(0, -5) });
      all[t.id] = t;
    } catch (e) {
      console.warn(`skipping template ${f}: ${(e as Error).message.replace(/\n/g, "; ")}`);
    }
  }
  return all;
}

export function saveTemplate(raw: unknown, dir = templateDir()): Template {
  const t = checkTemplate(raw);
  mkdirSync(dir, { recursive: true });
  const { id, builtin, ...data } = t;
  const path = join(dir, `${id}.json`);
  rmSync(`${path}.tmp`, { force: true }); // never write through a planted symlink
  writeFileSync(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
  renameSync(`${path}.tmp`, path);
  return t;
}

/** Remove a saved template (a built-in it overrode comes back). */
export function deleteTemplate(id: string, dir = templateDir()) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("bad template id");
  rmSync(join(dir, `${id}.json`), { force: true });
}

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

/** The template's blocks for these items. Blocks that come out empty (no text, a video without a preview) drop out.
 *  Throws if a button's text comes out longer than Patreon allows. */
export function expand(t: Template, text: string | undefined, items: { videos?: Video[]; images?: string[] }): Block[] {
  const list = t.needs === "videos" ? items.videos ?? [] : items.images ?? [];
  const global = { text: text?.trim() ?? "", count: String(list.length) };
  const render = (blocks: Block[], vars: Record<string, string>): Block[] =>
    blocks.flatMap((b): Block[] => {
      if ("paywall" in b || "divider" in b) return [b];
      if ("button" in b) {
        const out = { text: fill(b.button.text, vars).trim(), url: fill(b.button.url, vars).trim(), caption: fill(b.button.caption ?? "", vars).trim() };
        if (out.text.length > BUTTON_TEXT_MAX) throw new Error(`button text "${out.text}" is over Patreon's ${BUTTON_TEXT_MAX} characters`);
        if (out.caption.length > BUTTON_CAPTION_MAX) throw new Error(`button caption "${out.caption}" is over Patreon's ${BUTTON_CAPTION_MAX} characters`);
        return [{ button: { text: out.text, url: out.url, ...(out.caption ? { caption: out.caption } : {}) } }];
      }
      const [[key, v]] = Object.entries(b) as [[string, string]];
      const out = fill(v, vars).trim();
      return out ? [{ [key]: out } as Block] : [];
    });
  const each = (repeat: Block[]) => list.flatMap((item, i) => render(repeat, typeof item === "string"
    ? { ...global, n: String(i + 1), file: item, name: item.split("/").pop()!.replace(/\.[^.]+$/, "") }
    : { ...global, n: String(i + 1), name: item.title, play: item.url, preview: item.preview ?? "" }));
  return t.blocks.flatMap((b) => ("attachments" in b ? [] : "repeat" in b ? each(b.repeat) : render([b], global)));
}
