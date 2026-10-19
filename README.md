# vidpub

Videos → Bunny Stream (optionally into a collection) → Patreon post built from a template. Plain TypeScript and
API calls on Node 24, run on your Mac. No server, no build step, no AI agents, no extra cost beyond Bunny.

```
job.json ──► validate everything (files exist, template + publishers known) before uploading
         ──► videos only: find/create Bunny collection, then per video:
               create → resumable TUS upload (64 MB chunks) → poll every 30s until encoded
               failed / stuck → delete + re-upload (3 tries per run)
         ──► template builds the post → <job>.post.json  (the source of truth; edit it to change the post)
         ──► publishers (once) send exactly that file:
               patreon_manual  → content on clipboard + checklist
               patreon_browser → Patreon draft (or post) via Chrome
```

## Setup

```bash
npm install            # playwright (patreon_browser only), plus typescript + node types for typecheck
cp .env.example .env   # fill in BUNNY_LIBRARY_ID + BUNNY_API_KEY (not needed for image-only jobs)
```

## Use

A batch is a job file. Paths are relative to the job file, and `~/` works. Pick a template, a built-in or
one of yours (see [Templates](#templates)):

| Template | Post body | Example |
|---|---|---|
| `video-previews` | `post.text`, then per video its animated preview (Bunny's WebP) with its play link below | [job.video-previews.example.json](job.video-previews.example.json) |
| `image-gallery` | `post.text`, then the `images`, uploaded to Patreon. No Bunny involved | [job.image-gallery.example.json](job.image-gallery.example.json) |

| Field | |
|---|---|
| `template` | required when there's a post: a built-in or a saved template's id |
| `videos` | for a template that repeats over videos; uploaded and shown in this order |
| `images` | for one that repeats over images; shown in this order |
| `collection` | Bunny collection; omit to upload outside any collection |
| `post.title`, `post.access` | required. Access: `"public"`, `"patrons"`, `"paid"` or a list of tier names |
| `post.text` | fills the template's `{text}`; URLs become links |
| `post.thumbnail`, `post.attachments` | file paths |
| `post.collection` | Patreon collection (not the Bunny one) |
| `post.publishNow` | `patreon_browser` only: `true` publishes, default leaves a draft to review |
| `publish` | `patreon_manual` and/or `patreon_browser`; default `["patreon_manual"]` when there's a post |

**The post file is the source of truth.** The template writes `<job>.post.json`: the post settings plus a list of
blocks (`{ "text" }`, `{ "image" }` as a URL or file path, `{ "link" }`, `{ "button": { "text", "url", "caption" } }`,
`{ "divider": true }`, `{ "paywall": true }`). Publishers send exactly that. Edit it by hand to change the post;
reruns keep your edits. If you change the job after hand-editing the post file, the run
stops rather than overwrite your edits or send a stale post: delete the post file to rebuild it, or undo the change.
Jobs from before templates (`post.content` with `{links}`/`{previews}`) fail with the equivalent to use instead.

## Templates

A template is a post layout you build once and reuse: a list of blocks plus **repeat sections**, whose blocks come
out once per video (or image), in order. Built-ins are `video-previews` and `image-gallery`; yours are saved in
`~/.vidpub/templates/<id>.json` (one with a built-in's id replaces it). Build them in the GUI (New job → Template →
Edit or ＋ New template opens the editor): add blocks and repeat sections, drag them or use ↑ ↓, and watch the
**On Patreon** view render the post with the files in your folder.

| Block | On Patreon | Where |
|---|---|---|
| Text | paragraphs; URLs become links | anywhere |
| Image | `{preview}` (the video's animated WebP), `{file}` (the image) or an https URL | anywhere; `{preview}`/`{file}` in a repeat |
| Link | a URL on its own line | anywhere |
| Button | Patreon's button block: text (≤ 35), link, optional description (≤ 140) | anywhere |
| Divider | a line | anywhere |
| Paywall | "Paid access starts here": what's above it is free | once, not in a repeat; needs paid access |

Variables: `{text}` (the job's `post.text`) and `{count}` anywhere; in a repeat section `{name}`, `{n}`, plus
`{preview}` `{play}` for videos or `{file}` for images. A template is only the layout: title, access and
collections are the job's.

```json
{
  "name": "Member videos", "needs": "videos",
  "blocks": [
    { "text": "{text}" },
    { "paywall": true },
    { "repeat": [{ "image": "{preview}" }, { "button": { "text": "▶ Play", "url": "{play}", "caption": "{name}" } }, { "divider": true }] }
  ]
}
```

A paid post always gets exactly one paywall: where the template (or the preview) puts it, else at the top, so
everything is locked. Patreon's Audio and Attachments blocks aren't template blocks; attachments are a post setting.

```bash
caffeinate -i node vidpub.ts ~/Videos/2026-10/job.json   # caffeinate keeps the Mac awake
node vidpub.ts ~/Videos/clip.mp4                         # single video, no collection, no post
```

You get a macOS notification when it finishes or fails. **Rerun the same command anytime**: state lives
in `<job>.state.json`, so finished videos are skipped, interrupted uploads resume from where they
stopped, and failed ones are re-uploaded. Each run allows 3 fresh uploads per video before giving up.

## GUI

```bash
caffeinate -i npm run ui   # opens http://127.0.0.1:<port>/?t=<token> in your browser
```

The same flow without writing `job.json` by hand, in two steps:

1. Pick a folder (native macOS dialog; videos upload straight from it, nothing is copied), pick a template,
   tick and order the files (drag, or ↑ ↓), fill in the post, press Start. It writes `job.json` into that folder in
   the format above and adds the job to the **queue**; New job is then free for the next one. The queue uploads the
   videos and builds `<job>.post.json`. Nothing is sent yet.
2. In **Jobs**, a built job has **Review and send**: the **post preview** shows that file the way Patreon will. Edit
   the title and text, add or move the paywall (↑ ↓ or drag), save, then **Send to Patreon** (a draft, or published
   right away): that's queued too, and the draft link shows up in Jobs.

**The queue** (top of Jobs) runs one step at a time, in order, with live progress per job (upload %, encoding,
re-uploads, log). Uploads share your uplink and the Patreon profile can only be open in one Chrome, so running
steps side by side wouldn't be faster. A folder can't be queued twice, its post can't be edited while it's queued
or running, and reading tiers waits for a send to finish. A queued step can be cancelled; a running one stops with
Ctrl+C in the terminal.

"Who can see it" and "Patreon collection" list your real tiers and collections: **↻ Read tiers and collections
from Patreon** opens Chrome on the post editor for about 15 s and caches them in `~/.vidpub/patreon.json`. It reuses
one draft titled "vidpub scratch…" every time; leave that draft alone (deleting it just means the next read makes a
new one).

`node vidpub.ts <folder>/job.json` reruns a GUI job, and a CLI-made `job.json` opens in the GUI. Below the queue,
**Jobs** lists the jobs in folders you've picked, including ones built and waiting for review.
**Settings** writes the Bunny library ID and API key to `.env` and checks them with Bunny; the key is never shown
again.

The queue runs in the terminal process, not the tab: close the tab anytime and reopen the URL the terminal printed.
Ctrl+C stops it (and drops what's queued); Start again resumes like a CLI rerun. If you edited the preview and then
change the job, the build stops rather than drop your edits, and Jobs offers to rebuild the post from the job.

It only listens on 127.0.0.1, but any website you visit can send requests to localhost. So every request needs the
random per-launch token from the opened URL, Host and Origin must be the server's own (blocks DNS rebinding and
CSRF), and it only reads folders picked in the dialog (remembered in `~/.vidpub/ui.json`).

**A double-click Mac app is not built.** It would take Electron: a main process that calls `serve()` from
`ui/server.ts` and loads its URL in a window, `dialog.showOpenDialog` in place of osascript, Node and playwright
bundled (Chrome stays the user's own), and electron-builder producing a signed, notarized `.app`, which needs an
Apple Developer ID ($99/yr). Without signing, users have to get past Gatekeeper by hand.

## Patreon

Patreon's official API (v2) **can't create posts, set tier access or add posts to collections**. Post
endpoints are read-only, and the only write endpoints are livestreams and webhooks (checked Oct 2026). Two
publishers work around that:

- **`patreon_manual`** copies the content to your clipboard and writes `<job>.patreon.txt`: the content plus a
  checklist (title, thumbnail, access, collection, attachments) to apply in the editor yourself.
- **`patreon_browser`** fills in Patreon's web editor for you: access, thumbnail (as the post's cover image), title,
  the blocks (text, links, images: URLs inserted by URL, files uploaded; buttons, dividers, the paywall), attachments,
  collection. It checks every block came out in order, then leaves a **draft** and prints its URL. Set
  `post.publishNow: true` to publish instead. `post.access` is required, so links never go out public by
  accident.

`patreon_browser` setup, once (needs Google Chrome in /Applications):

```bash
node patreon-login.ts   # Chrome opens: log in to Patreon, then quit it with Cmd+Q
```

That's a separate Chrome profile at `~/.vidpub/patreon-profile`, opened without automation because Google
refuses sign-in in automated browsers. You type your password into Patreon, never into vidpub, and only
Patreon's cookies are kept. Rerun it whenever `patreon_browser` says you're logged out.

When it runs, a Chrome window opens and fills the post in about 15 s (longer for big attachments). It has to
be a visible window, because Cloudflare blocks headless Chrome, and a Mac that's asleep or locked stalls it.
If anything is missing or doesn't stick (an unknown tier or collection, a failed upload), it stops before
Publish, saves a screenshot to `<job>.patreon-error.png` and names the unfinished draft. Delete that draft
and rerun the job: uploads are skipped and only the publisher runs again.

**Risks.** This is unofficial automation of Patreon's UI. It breaks when Patreon changes the editor. The
selectors live in one place (`S` in `patreonBrowser`) and were calibrated in Oct 2026. Patreon's Terms of
Use (May 2026) don't ban scripts or bots outright, but forbid anything that "abuses Patreon in a technical way",
and Patreon decides what counts. One post per job on your own account, at human speed, is low risk, but not
zero: the worst case is a flag or lock on the account. If that risk matters more than a minute of clicking,
use `patreon_manual`.

## Bunny links aren't paywalled

The Patreon paywall hides the post, not the Bunny link. Anyone the link is shared with can watch. Bunny's
library → Security → **Allowed domains** checks the Referer header. Patreon may strip the Referer from
outbound links, which would block your patrons too, so test with a patron account before turning it on.

Preview images are inserted by URL (`https://vz-….b-cdn.net/<guid>/preview.webp`; the host comes from Bunny's
`thumbnailUrl`, so there's nothing to configure). Uploading the file instead makes Patreon re-encode it as a still
image. If your library blocks direct file access or limits allowed domains, make sure Patreon pages can load them.

## Ideas, not built yet

- `videos` pointing at a folder instead of listing every file.
- One post per video from a single job.
- Scheduling (Patreon's "Set publish date").

## Extending

- **New destination** (Discord, email, another platform): add a `Publisher` to `publishers.ts`, register it in
  `PUBLISHERS`, and list it in the job's `publish`. A publisher is `(doc: PostDoc, jobPath) => string | Promise<string>`:
  it gets the post doc and returns a URL or path, which is saved so reruns skip it.
- **New block type**: add it to `Block` (publishers.ts), `checkBlock`/`expand` (templates.ts), the publishers, the
  GUI's `KIND`/`pageBlock`/`newBlock`, and `postProblems` (ui/server.ts).
- **Other Bunny calls**: add them to `bunny.ts`.

## Check

```bash
npm test && npm run typecheck   # no network: TUS resume, retry/replace, give-up, rerun, job validation, templates, GUI job writing + preview edits
```
