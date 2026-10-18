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

A batch is a job file. Paths are relative to the job file, and `~/` works. Pick a template:

| Template | Post body | Example |
|---|---|---|
| `video-previews` | `post.text`, then per video its animated preview (Bunny's WebP) with its play link below | [job.video-previews.example.json](job.video-previews.example.json) |
| `image-gallery` | `post.text`, then the `images`, uploaded to Patreon. No Bunny involved | [job.image-gallery.example.json](job.image-gallery.example.json) |

| Field | |
|---|---|
| `template` | required when there's a post |
| `videos` | for `video-previews`; uploaded and shown in this order |
| `images` | for `image-gallery`; shown in this order |
| `collection` | Bunny collection; omit to upload outside any collection |
| `post.title`, `post.access` | required. Access: `"public"`, `"patrons"`, `"paid"` or a list of tier names |
| `post.text` | paragraph(s) on top; URLs become links |
| `post.thumbnail`, `post.attachments` | file paths |
| `post.collection` | Patreon collection (not the Bunny one) |
| `post.publishNow` | `patreon_browser` only: `true` publishes, default leaves a draft to review |
| `publish` | `patreon_manual` and/or `patreon_browser`; default `["patreon_manual"]` when there's a post |

**The post file is the source of truth.** The template writes `<job>.post.json`: the post settings plus a list of
blocks (`{ "text" }`, `{ "image" }` as a URL or file path, `{ "link" }`). Publishers send exactly that. Edit it by
hand to change the post; reruns keep your edits. If you change the job after hand-editing the post file, the run
stops rather than overwrite your edits or send a stale post: delete the post file to rebuild it, or undo the change.
Jobs from before templates (`post.content` with `{links}`/`{previews}`) fail with the equivalent to use instead.

```bash
caffeinate -i node vidpub.ts ~/Videos/2026-10/job.json   # caffeinate keeps the Mac awake
node vidpub.ts ~/Videos/clip.mp4                         # single video, no collection, no post
```

You get a macOS notification when it finishes or fails. **Rerun the same command anytime**: state lives
in `<job>.state.json`, so finished videos are skipped, interrupted uploads resume from where they
stopped, and failed ones are re-uploaded. Each run allows 3 fresh uploads per video before giving up.

## Patreon

Patreon's official API (v2) **can't create posts, set tier access or add posts to collections**. Post
endpoints are read-only, and the only write endpoints are livestreams and webhooks (checked Oct 2026). Two
publishers work around that:

- **`patreon_manual`** copies the content to your clipboard and writes `<job>.patreon.txt`: the content plus a
  checklist (title, thumbnail, access, collection, attachments) to apply in the editor yourself.
- **`patreon_browser`** fills in Patreon's web editor for you: thumbnail (as the post's cover image), title,
  the blocks (text, links, images: URLs inserted by URL, files uploaded), attachments, access, collection. It leaves a **draft** and prints its URL. Set
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
  `PUBLISHERS`, and list it in the job's `publish`. It gets the post plus `[{title, url}]` once all videos
  are playable.
- **Other Bunny calls**: add them to `bunny.ts`.

## Check

```bash
npm test && npm run typecheck   # no network: TUS resume, retry/replace, give-up, rerun, job validation
```
