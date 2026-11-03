/* THE LAPTOP'S OWN CLOUDFLARE LOGIN, FOR A NODE SCRIPT (2026-11-03).
 *
 * Ayush, going live: "just help me with what I need to execute." Making a D1
 * API token in the dashboard and pasting it into .env.local was five of those
 * steps. `npx wrangler login` already holds a token for the same account with
 * D1 write access, so the scripts use that one instead: CF_WRANGLER_LOGIN=1.
 *
 * The token lasts about an hour. It is asked of `wrangler auth token --json`
 * (or, on an older wrangler, read from its config file) — never printed,
 * never written anywhere else — and asked again when Cloudflare refuses it.
 *
 * WRANGLER_CMD replaces "npx wrangler" (tests point it at a stub).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* Where wrangler keeps its login, newest layout first. */
export function wranglerConfigFile(env = process.env) {
  if (env.WRANGLER_AUTH_FILE) return env.WRANGLER_AUTH_FILE;
  const h = homedir();
  const places = [
    env.XDG_CONFIG_HOME && join(env.XDG_CONFIG_HOME, ".wrangler"),
    join(h, "Library", "Preferences", ".wrangler"),           /* macOS */
    join(h, ".config", ".wrangler"),                          /* Linux */
    env.APPDATA && join(env.APPDATA, ".wrangler"),            /* Windows */
    join(h, ".wrangler"),                                     /* older wranglers */
  ].filter(Boolean).map((d) => join(d, "config", "default.toml"));
  return places.find((f) => existsSync(f)) || null;
}

const field = (text, k) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1] || "";

export function readLogin(env = process.env) {
  const f = wranglerConfigFile(env);
  if (!f) return null;
  const t = readFileSync(f, "utf8");
  const token = field(t, "oauth_token");
  return token ? { token, expires: Date.parse(field(t, "expiration_time")) || 0 } : null;
}

/* The wrangler command, as an argv. */
export function wranglerArgv(env = process.env) {
  return String(env.WRANGLER_CMD || "npx wrangler").trim().split(/\s+/);
}

/* Run wrangler. quiet: capture output (returned); otherwise the person sees it. */
export function wrangler(args, { env = process.env, quiet = false, input, cwd } = {}) {
  const [cmd, ...pre] = wranglerArgv(env);
  const r = spawnSync(cmd, [...pre, ...args], {
    env, input, cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    stdio: quiet ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}

/* The token, asked of wrangler itself (`wrangler auth token --json`, which
   renews an expired login and knows about keychains and profiles), kept for
   ten minutes. Older wranglers without that command: read from the file. */
let cached = null;
const KEEP_MS = 10 * 60_000;

function fromWrangler(env) {
  const r = wrangler(["auth", "token", "--json"], { env, quiet: true });
  if (r.code !== 0) return null;
  const i = r.stdout.indexOf("{"), j = r.stdout.lastIndexOf("}");
  try { const o = JSON.parse(r.stdout.slice(i, j + 1)); return o?.token || null; } catch { return null; }
}

export async function refreshWranglerToken(env = process.env) {
  cached = null;
  const t = fromWrangler(env);
  if (t) { cached = { token: t, at: Date.now() }; return; }
  wrangler(["d1", "list", "--json"], { env, quiet: true });     /* renews the file's token */
}

export async function wranglerToken(env = process.env) {
  if (cached && Date.now() - cached.at < KEEP_MS) return cached.token;
  const t = fromWrangler(env);
  if (t) { cached = { token: t, at: Date.now() }; return t; }
  let l = readLogin(env);
  if (l && l.expires && l.expires - Date.now() < 120_000) { wrangler(["d1", "list", "--json"], { env, quiet: true }); l = readLogin(env); }
  if (!l) throw new Error("No Cloudflare login on this laptop — run: npx wrangler login");
  return l.token;
}
