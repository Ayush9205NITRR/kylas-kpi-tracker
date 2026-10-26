/* WHO MAY GIVE A STALLED CONTACT'S REASON — its owner.
 *
 * Ayush, 2026-10-26: "yeh contact owner ko bharne hai". The reason a contact
 * stopped moving is the owner's to give; an admin looking at the whole team
 * sees WHO owes one (the table) but does not answer for them.
 *
 *   an associate     only their own contacts
 *   an admin         the same — the console offers them only their own. The
 *                    server lets an admin through, so a contact whose owner
 *                    has left (nobody can ever answer it) is not stranded.
 *
 * Names are compared as the base spells them (the Owner column is the Kylas
 * owner's name, copied at save), case and spacing aside.
 */
export const sameName = (a, b) => {
  const n = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return !!n(a) && n(a) === n(b);
};
export const mayAnswerRca = ({ role, user, owner }) => role === "admin" || sameName(user, owner);
