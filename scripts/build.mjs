/* Which copy of this repo is running, printed by anything a person runs by
 * hand.
 *
 * THIS EXISTS BECAUSE OF A SPECIFIC HOUR. A fix went out, Ayush ran the
 * script, and the output was the old message — word for word, including the
 * sentence the fix had deleted. The script had not changed on his disk. There
 * was no way to tell that from the output, so the obvious reading was that the
 * fix had not worked, and the next hour went into the wrong question.
 *
 * It is not the first time: the same thing cost four rounds on the extension
 * in September, and the answer there was a content hash the console prints on
 * screen. This is the same answer for the command line.
 *
 * The SHA alone is not enough. This repo has been cloned more than once on
 * that machine, so "which commit" and "which folder" are different questions
 * and only the second one explains a pull that appears to do nothing. Both are
 * printed, along with whether the working tree is dirty — a local edit is the
 * third way to be running something other than what the branch says.
 */
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;

export function build() {
  const out = { root: ROOT.replace(/\/$/, ""), branch: "", sha: "", dirty: false, git: false };
  try {
    const git = (a) => execFileSync("git", a, {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    out.branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    out.sha = git(["rev-parse", "--short", "HEAD"]);
    out.dirty = git(["status", "--porcelain"]).length > 0;
    out.git = true;
  } catch { /* no git, or not a checkout: the path alone still answers "which folder" */ }
  return out;
}

/* One line, meant to sit under a script's own title. */
export function buildLine() {
  const b = build();
  if (!b.git) return `running from ${b.root} (not a git checkout)`;
  return `running ${b.branch} ${b.sha}${b.dirty ? " + local edits" : ""} from ${b.root}`;
}
