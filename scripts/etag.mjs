/* NOT SENDING THE SAME ANSWER TWICE.
 *
 * The company list is the biggest reply this server makes — at ten thousand
 * companies it is 5.7MB of JSON, about 300KB once the network has compressed
 * it — and the console asks for it every time it opens. Most of those asks get
 * back exactly what the console already has.
 *
 * So each reply carries an ETag, the console sends it back as If-None-Match,
 * and an unchanged answer is a 304 with no body at all. The second and every
 * later open costs a few hundred bytes instead of a few hundred kilobytes,
 * and — the part that matters more on a laptop — the browser does not parse
 * 5.7MB of JSON it already has.
 *
 * WHY HASH THE BODY RATHER THAN VERSION THE DATA. A version number has to be
 * bumped by whoever changes the data, and the one time somebody forgets, the
 * console shows yesterday's list and there is nothing on screen to say so.
 * Hashing what is about to be sent cannot be forgotten. It costs a pass over
 * the string, which is cheap next to sending it.
 *
 * VOLATILE FIELDS ARE LEFT OUT OF THE HASH. `cachedSeconds` is how old the
 * server's copy is and it changes on every single request — including the hash
 * would mean no two replies ever matched and this would quietly do nothing but
 * add work. It is a diagnostic, so a client holding a stale one is harmless.
 */

/* Keys whose value changes on every request without the ANSWER changing. */
const VOLATILE = new Set(["cachedSeconds"]);

/* FNV-1a, 32-bit, over the string. Not a cryptographic hash and does not need
   to be: the question is "did this change", and the cost of a collision is one
   stale list until the next change, not a security hole. Two of them over
   different seeds, so a collision needs both to agree. */
function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* The serialised body, and its tag. Returned together because the caller needs
   both and serialising twice on a 5.7MB reply is not free. */
export function taggedBody(body) {
  const text = JSON.stringify(body);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { text, etag: tagOf(text) };
  /* Only re-serialise when there is something volatile to leave out. */
  const hasVolatile = Object.keys(body).some((k) => VOLATILE.has(k));
  const forHash = hasVolatile
    ? JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => !VOLATILE.has(k))))
    : text;
  return { text, etag: tagOf(forHash) };
}

const tagOf = (s) =>
  `"${fnv(s, 0x811c9dc5).toString(36)}${fnv(s, 0x9e3779b9).toString(36)}-${s.length.toString(36)}"`;

/* Does the client already have this answer? A browser may send several tags,
   and a proxy may have weakened one to W/"…" — both are handled, because a
   comparison that is almost right here shows as "the list never refreshes". */
export function matches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  const strip = (t) => t.trim().replace(/^W\//, "");
  return String(ifNoneMatch).split(",").some((t) => strip(t) === strip(etag));
}

/* Only reads are cacheable, and only ones that succeeded. A 304 for a POST, or
   for an error, would be a bug that looked like a cache working. */
export const cacheable = (method, status) =>
  (method === "GET" || method === undefined) && status === 200;
