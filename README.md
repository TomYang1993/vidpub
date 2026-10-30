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
| `post.collection` | Patreon collection name, or a list of them: a post can be in several (not the Bunny collection) |
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
| Attachments | the job's files themselves (the videos), attached to the post. Patreon always shows attachments in their own section below the post, so it stays last | once, not in a repeat |

A template that never uses `{preview}` or `{play}` doesn't need Bunny: its videos aren't uploaded there at all. An
attachments-only template (for example Text `{text}` + Attachments) sends the video files straight to Patreon as
attachments; the button then reads "Save as a Patreon draft". Patreon's attachment size limit isn't documented
anywhere vidpub could read: a file Patreon refuses fails the send with Patreon's own message, and each attachment
gets up to 3 hours to upload.

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

The same flow without writing `job.json` by hand, in one go:

1. **New job:** pick a folder (native macOS dialog; videos upload straight from it, nothing is copied), tick and
   order the files (drag, or ↑ ↓), pick a template, fill in the post, and choose **Save as a draft** or **Publish
   right away**. Press **Upload and save as a Patreon draft** (or **…publish on Patreon**). It writes `job.json`
   into the folder and adds the job to the queue; New job is blank again for the next one.
2. **Jobs:** the job goes queued → uploading → waiting to send → sending → done. It uploads the videos, builds
   `<job>.post.json` from the template, then sends exactly that to Patreon: Chrome opens and fills in the editor
   (this needs `node patreon-login.ts` once). Done shows **Open the draft** (Patreon's edit page, to review and
   publish there) or **Open the post** if you chose Publish right away. **Details** opens the job's live progress
   (upload %, encoding, re-uploads, play links, log).

Review happens on Patreon: that's what the draft is for. The template's **On Patreon** view shows the layout
before you start. The thumbnail can be an image in the folder, or **Upload image…** copies one into the folder
(only files in the folder are ever sent).

**The queue** has two lanes, each running one job phase at a time in order: uploads (they share your uplink) and
sends (the Patreon profile can only be open in one Chrome). The lanes run side by side, so a send doesn't wait
behind another job's upload; a job's own send starts only after its upload and build. A folder can't be queued
twice, and reading tiers waits for a send to finish. A queued job can be cancelled; a running one stops with
Ctrl+C in the terminal. A failed send has **Send again**; a built job that was never sent has **Send** in the jobs
list.

"Who can see it" and "Patreon collection" list your real tiers and collections: **↻ Read tiers and collections
from Patreon** opens Chrome on the post editor for about 15 s and caches them in `~/.vidpub/patreon.json`. It reuses
one draft titled "vidpub scratch…" every time; leave that draft alone (deleting it just means the next read makes a
new one).

`node vidpub.ts <folder>/job.json` reruns a GUI job, and a CLI-made `job.json` opens in the GUI. Below the queue,
**Jobs** lists the jobs in folders you've picked.
**Settings** writes the Bunny library ID and API key to `.env` and checks them with Bunny; the key is never shown
again.

The queue runs in the terminal process, not the tab: close the tab anytime and reopen the URL the terminal printed.
Ctrl+C stops it (and drops what's queued); Start again resumes like a CLI rerun: finished uploads are kept. If
you hand-edited `<job>.post.json` and then change the job, the build stops rather than drop your edits, and Jobs
offers to rebuild the post from the job.

It only listens on 127.0.0.1, but any website you visit can send requests to localhost. So every request needs the
random per-launch token from the opened URL, Host and Origin must be the server's own (blocks DNS rebinding and
CSRF), and it only reads folders picked in the dialog (remembered in `~/.vidpub/ui.json`).

**A double-click Mac app is not built.** It would take Electron: a main process that calls `serve()` from
`ui/server.ts` and loads its URL in a window, `dialog.showOpenDialog` in place of osascript, Node and playwright
bundled (Chrome stays the user's own), and electron-builder producing a signed, notarized `.app`, which needs an
Apple Developer ID ($99/yr). Without signing, users have to get past Gatekeeper by hand.

## Library

The **Library** tab works on everything in your Bunny Stream library, not just what vidpub uploaded:

- **Last 30 days:** views, watch time, top country, views per day.
- **Popular:** every video ranked by views over the last 7, 30 or 90 days, with the change against the period
  before (↑ / ↓ / new), views per day, and the all-time total, plus the same totals per collection. It reads each
  video's daily views from Bunny (one API call per video, 6 at a time), so ranking a few hundred videos takes about
  half a minute; the result is kept for 6 hours (↻ Refresh redoes it).
- **Videos:** search titles (Bunny searches titles only), filter by collection, sort; each row shows its collection,
  views, watch time, length and upload date. Tick videos to **move** them to another collection, a new one, or none.
- **A video's popup:** its numbers, views per day, **where people watch** (Bunny's heatmap: which parts get
  watched and rewatched), top countries, and **Download**: one MP4 at 1080p (or the best below) into your Downloads
  folder, queued in Jobs like uploads. It uses Bunny's MP4 file when the library makes them ("MP4 fallback", for
  videos uploaded after it was enabled), otherwise copies the 1080p stream into an MP4 with ffmpeg
  (`brew install ffmpeg`), without re-encoding. A library with token authentication, "Block direct URL file
  access" or an Allowed domains list refuses downloads.

- **Post from videos already on Bunny:** tick videos and press **Post from selected**, or filter by a collection and
  press **Post from this collection**. New job then lists those videos instead of a folder's (reorder or untick as
  usual); pick a template, fill in the post, and Start. Nothing is uploaded: each video must be ready on Bunny, and the
  post gets its play link and animated preview like an uploaded video. The job lives in
  `~/.vidpub/jobs/<date> <title>/` (job.json lists `"bunny": [{ "id", "title" }]`), shows in Jobs and reopens there.
  Attachments-only templates can't be used this way: there's no local file to attach.
- **Clean up:** proposes a batch of videos to delete to save storage: at most N views in the last 30 or 90 days,
  uploaded more than D days ago (new videos haven't had time), up to a batch size; least-viewed first and, among
  equals, biggest first, so each batch frees the most space. Every video shows why it's proposed ("no views in the
  last 90 days · 3 views ever · uploaded 142 days ago") and its size; untick any to keep. **Delete** asks you to type
  the number of videos, then deletes them from Bunny for good and logs each one (title, size, collection, views,
  reason, date) to `~/.vidpub/deleted.jsonl`; "Deleted so far" shows the total. Videos used in a vidpub Patreon post
  (any picked folder's job that was sent) are left out unless you tick "Include videos used in Patreon posts":
  deleting them breaks those posts. vidpub never deletes collections (Bunny deletes a collection's videos with it).

Bunny counts plays, not people: there's no per-viewer or per-patron data.

## Patreon

Patreon's official API (v2) **can't create posts, set tier access or add posts to collections**. Post
endpoints are read-only, and the only write endpoints are livestreams and webhooks (checked Oct 2026). Two
publishers work around that:

- **`patreon_manual`** copies the content to your clipboard and writes `<job>.patreon.txt`: the content plus a
  checklist (title, thumbnail, access, collection, attachments) to apply in the editor yourself.
- **`patreon_browser`** fills in Patreon's web editor for you: access, thumbnail (as the post's cover image), title,
  the blocks (text, links, images: URLs inserted by URL, files uploaded; buttons, dividers, the paywall), attachments,
  collection. It checks every block came out in order, then leaves a **draft** and prints its URL. Access and
  collections are set and saved first, before any slow upload, and applied again at the end. The job records its
  draft as soon as it exists: if a send is interrupted (Chrome closed, Mac asleep, Ctrl+C), **Send again** /
  **Finish sending** continues that draft and uploads only the attachments it doesn't have yet, instead of starting
  over. Don't open a draft in your own browser while vidpub is sending it: Patreon allows one editor per post. Set
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
