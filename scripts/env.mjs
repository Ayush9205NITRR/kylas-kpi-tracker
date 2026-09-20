/* Read .env.local, so nothing has to be sourced first.
 *
 * Import it for the side effect, before anything reads process.env:
 *
 *   import "./env.mjs";
 *
 * WHY THIS EXISTS
 * `source .env.local && node scripts/proxy.mjs` asks a person to remember two
 * things that have nothing to do with each other, and it fails in three ways
 * that all look the same from the terminal:
 *
 *   - a new tab. `source` sets SHELL variables, not machine ones, so every
 *     terminal needs it again and the second one reports "Set KYLAS_KEY" as
 *     though the key were wrong.
 *   - the wrong directory. `source: no such file or directory: .env.local`
 *     says nothing about which directory it looked in.
 *   - a fresh clone, where the file is legitimately absent because it is
 *     gitignored and has never left the machine that made it.
 *
 * Ayush hit all three on 2026-09-20. None of them is a mistake worth making
 * twice, so the scripts read the file themselves.
 *
 * WHAT IT DOES NOT DO
 * It never overwrites a variable that is already set. An explicit
 * `KYLAS_KEY=x node scripts/proxy.mjs`, a value exported by hand, and the
 * mock-stack variables the tests pass all still win — this is the fallback,
 * not the authority. So `source .env.local` also keeps working exactly as it
 * did, which matters because every doc and every cron line says to.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* Up from scripts/, then further up, so it is found whether you run from the
   repo root, from scripts/, or from a cron line with an absolute path. The
   repo root is the normal answer and comes first. */
function findEnvFile(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return "";
}

/* KEY=value, one per line. `export KEY=value` too, because that is what the
   file has to say to remain sourceable — and it must remain sourceable, or
   this change would break every cron line and every instruction already
   written down. Quotes are stripped; a # starts a comment only at the
   beginning of a line, because a key can legitimately contain one. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = process.env.ENV_FILE
  ? resolve(process.env.ENV_FILE)
  : findEnvFile(here);

export const loaded = [];
if (ENV_FILE && existsSync(ENV_FILE)) {
  let vars = {};
  try {
    vars = parseEnv(readFileSync(ENV_FILE, "utf8"));
  } catch (e) {
    /* Unreadable is worth saying out loud — silently carrying on would look
       exactly like the file not existing, which sends the reader to fix the
       wrong thing. */
    console.error(`! could not read ${ENV_FILE}: ${e.message}`);
  }
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) { process.env[k] = v; loaded.push(k); }
  }
}

/* What to print when a required variable is still missing. Kept here so all
   fifteen scripts say the same thing, and so it can name the file it actually
   looked at rather than a path from the documentation. */
export function explainMissing(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (!missing.length) return "";
  const lines = [`${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set.\n`];
  if (ENV_FILE) {
    lines.push(`  Read ${ENV_FILE}`);
    lines.push(loaded.length ? `  It set: ${loaded.join(", ")}`
                             : `  It set nothing — is it empty, or are the lines commented out?`);
    lines.push(`  Add the missing one${missing.length === 1 ? "" : "s"} to that file.\n`);
  } else {
    lines.push(`  No .env.local was found, searching up from ${here}.\n`);
    lines.push(`  Make one in the repo root:`);
    lines.push(`    cp .env.local.example .env.local\n`);
    lines.push(`  Had one before a re-clone? Find it rather than issuing new keys:`);
    lines.push(`    find ~ -name .env.local -not -path '*/node_modules/*' 2>/dev/null\n`);
  }
  if (missing.includes("KYLAS_KEY"))
    lines.push(`  Kylas key:    app.kylas.io/setup/integrations/api-keys/list`);
  if (missing.includes("AIRTABLE_PAT"))
    lines.push(`  Airtable PAT: airtable.com/create/tokens`);
  if (missing.includes("AIRTABLE_BASE"))
    lines.push(`  Base id:      from the base's URL, airtable.com/appXXXXXXXXXXXXXX/...`);
  return lines.join("\n");
}

/* Exit with that message, or return having done nothing. */
export function requireEnv(...names) {
  const why = explainMissing(names);
  if (!why) return;
  console.error(why);
  process.exit(1);
}
