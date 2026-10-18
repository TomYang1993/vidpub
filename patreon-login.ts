// One-off: log in to Patreon in the browser profile the patreon_browser publisher uses.
// Opens plain Google Chrome with no automation attached (Google refuses sign-in in automated browsers).
// You log in yourself; this script never sees or stores your password, only Patreon's cookies stay in
// the profile. Rerun it whenever patreon_browser says you're logged out.
//
// Usage: node patreon-login.ts   (log in, then quit that Chrome window with Cmd+Q)
import { spawnSync } from "node:child_process";
import { PATREON_PROFILE, openPatreonProfile, patreonLoggedIn } from "./publishers.ts";

console.log("Log in to Patreon in the Chrome window that opens, then quit it with Cmd+Q.");
const chrome = spawnSync("open", ["-n", "-W", "-a", "Google Chrome","--args", `--user-data-dir=${PATREON_PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "https://www.patreon.com/login"]);
if (chrome.status !== 0) throw new Error(`couldn't open Google Chrome: ${chrome.stderr}`);

const ctx = await openPatreonProfile(true);
const ok = await patreonLoggedIn(ctx);
await ctx.close();
console.log(ok ? `Logged in. Profile saved at ${PATREON_PROFILE}` : "Not logged in. Run it again.");
process.exitCode = ok ? 0 : 1;
