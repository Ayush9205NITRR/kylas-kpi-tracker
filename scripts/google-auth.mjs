/* Proving who is calling, without Cloudflare Access.
 *
 * The extension signs the associate in with Google and sends the resulting ID
 * token. This verifies it. If it says yes, the request is from a real person at
 * a real address in your organisation; if it throws, nothing else runs.
 *
 * THE SERVER HOLDS A KYLAS KEY AND AN AIRTABLE TOKEN, so this file is the only
 * thing standing between the open internet and the CRM. Every check below is
 * load-bearing, and the ways to get this wrong all look like working code:
 *
 *   no signature check      anyone can write {"email":"ayush@enout.in"} in
 *                           base64 and be believed
 *   no `aud` check          ANY Google token for ANY app in the world is
 *                           accepted — someone's Spotify login would do
 *   no `iss` check          a token from an issuer you have never heard of
 *   no `exp` check          a token leaked a year ago still works
 *   email_verified ignored  an unverified address can be set to anything on
 *                           some account types
 *   domain by `endsWith`    "@enout.in.attacker.com" ends with nothing useful,
 *                           but "evil@notenout.in" ends with "enout.in"
 *
 * The last one is why the domain test splits on "@" rather than matching the
 * end of the string.
 *
 * WHY AN ID TOKEN AND NOT AN ACCESS TOKEN. An access token is opaque and can
 * only be checked by asking Google on every request — a round trip in front of
 * every save, and an outage at Google becomes an outage here. An ID token is a
 * signed statement that can be checked locally against Google's published keys,
 * which are fetched rarely and cached.
 */

const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

const b64urlToBytes = (s) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlToJSON = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

/* A failure the caller can turn into a 401 without leaking which check failed
   to the person who tripped it. The REASON is for the log, not the response. */
const deny = (reason) => Object.assign(new Error(reason), { status: 401, authFailure: true });

export function createGoogleAuth({
  clientId,
  allowedDomain = "",
  allowedEmails = [],
  /* Injected so a suite can mint its own keys and never touch the network. */
  fetchImpl = fetch,
  now = () => Date.now(),
  jwksUrl = GOOGLE_JWKS,
  log = () => {},
} = {}) {
  if (!clientId) throw new Error("createGoogleAuth needs the OAuth clientId to check `aud` against");

  const domain = String(allowedDomain || "").replace(/^@/, "").toLowerCase();
  const emails = new Set(allowedEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  if (!domain && !emails.size)
    throw new Error("createGoogleAuth needs allowedDomain or allowedEmails — otherwise any Google account is let in");

  /* Google's signing keys, cached. They rotate every few days and the cache is
     keyed on `kid`, so a rotation is a miss and one fetch rather than an
     outage. Refetched at most once a minute on a miss, so a token naming a kid
     that does not exist cannot turn into a fetch per request. */
  let keys = new Map();          /* kid -> CryptoKey */
  let fetchedAt = 0;
  let inflight = null;

  async function loadKeys() {
    if (inflight) return inflight;
    inflight = (async () => {
      const res = await fetchImpl(jwksUrl);
      if (!res.ok) throw deny(`could not fetch Google's signing keys (${res.status})`);
      const { keys: jwks } = await res.json();
      const next = new Map();
      for (const jwk of jwks || []) {
        if (jwk.kty !== "RSA" || (jwk.alg && jwk.alg !== "RS256")) continue;
        next.set(jwk.kid, await crypto.subtle.importKey(
          "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
      }
      keys = next;
      fetchedAt = now();
      log(`google: ${keys.size} signing key(s) loaded`);
      return keys;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  async function keyFor(kid) {
    if (keys.has(kid)) return keys.get(kid);
    /* A miss is either a rotation or a forged kid. Refetch, but not more than
       once a minute, so the second case cannot be used to make this server
       hammer Google. */
    if (now() - fetchedAt > 60_000) await loadKeys();
    const k = keys.get(kid);
    if (!k) throw deny(`no Google signing key for kid ${kid}`);
    return k;
  }

  return {
    /* Returns { email, sub, name } or throws. Nothing partial: a caller that
       forgets to catch gets no identity rather than a hopeful one. */
    async verify(idToken) {
      const jwt = String(idToken || "").trim();
      if (!jwt) throw deny("no token");
      const parts = jwt.split(".");
      if (parts.length !== 3) throw deny("not a JWT");
      const [rawHeader, rawPayload, rawSig] = parts;

      let header, claims;
      try {
        header = b64urlToJSON(rawHeader);
        claims = b64urlToJSON(rawPayload);
      } catch { throw deny("token is not readable"); }

      /* alg comes from the token, so it is ATTACKER-CONTROLLED. Pinning it is
         what stops the "alg":"none" family of forgeries, where a token with no
         signature is accepted because the verifier believed its header. */
      if (header.alg !== "RS256") throw deny(`unexpected alg ${header.alg}`);
      if (!header.kid) throw deny("no kid");

      const key = await keyFor(header.kid);
      const ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5", key,
        b64urlToBytes(rawSig),
        new TextEncoder().encode(`${rawHeader}.${rawPayload}`));
      if (!ok) throw deny("signature does not verify");

      /* Everything below is only meaningful because the signature passed. */
      if (!GOOGLE_ISSUERS.includes(claims.iss)) throw deny(`issuer ${claims.iss}`);
      /* WITHOUT THIS, ANY GOOGLE TOKEN FOR ANY APP IS ACCEPTED. Google signs
         tokens for millions of applications with these same keys; `aud` is the
         only thing saying this one was minted for us. */
      if (claims.aud !== clientId) throw deny("token was issued for a different application");

      const seconds = Math.floor(now() / 1000);
      /* 60s of slack for clock skew, and no more: this is how long a stolen
         token stays usable past its expiry. */
      if (!claims.exp || claims.exp + 60 < seconds) throw deny("token has expired");
      if (claims.iat && claims.iat - 60 > seconds) throw deny("token is from the future");

      const email = String(claims.email || "").toLowerCase();
      if (!email) throw deny("token carries no email");
      /* An unverified address is one the account holder typed, not one Google
         checked. */
      if (claims.email_verified !== true && claims.email_verified !== "true")
        throw deny("email is not verified");

      /* SPLIT ON "@", DO NOT MATCH THE END OF THE STRING. `endsWith("enout.in")`
         is true of "someone@notenout.in", which is a domain anybody can buy. */
      const at = email.lastIndexOf("@");
      const emailDomain = at > -1 ? email.slice(at + 1) : "";
      const domainOk = domain && emailDomain === domain;
      const listedOk = emails.has(email);
      if (!domainOk && !listedOk) throw deny(`${email} is not allowed here`);

      return { email, sub: String(claims.sub || ""), name: claims.name || "" };
    },

    /* For a test or a health check to see the cache is doing its job. */
    get keyCount() { return keys.size; },
  };
}
