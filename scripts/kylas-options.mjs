/* Picklist options out of a Kylas field definition.
 *
 * Lives on its own so that field-map.mjs (a CLI as well as a module) can read it
 * without importing push-kylas.mjs, which imports field-map.mjs: run as the entry
 * point, that cycle plus a top-level await never settles ("Detected unsettled
 * top-level await") and the command prints nothing.
 */

/* Options are nested at a different depth per field type. */
export function findOptions(f, d = 0) {
  if (!f || d > 4) return null;
  if (Array.isArray(f)) {
    if (f.length && f.every((x) => x && typeof x === "object" && (x.name || x.displayName)))
      return f.map((x) => ({ id: x.id, code: x.name || x.displayName, label: x.displayName || x.name }));
    for (const x of f) { const h = findOptions(x, d + 1); if (h) return h; }
    return null;
  }
  if (typeof f === "object") for (const k of Object.keys(f)) { const h = findOptions(f[k], d + 1); if (h) return h; }
  return null;
}
