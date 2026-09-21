#!/usr/bin/env node
/* The migrations' "does this base have the column" guard.
 *
 *   node scripts/test-migrations.mjs
 *
 * Ayush, 2026-09-22, after repair-base had already run:
 *
 *     ! no contact on this base carries First Right POC At or First Discovery At.
 *       The columns do not exist yet — run scripts/repair-base.mjs first
 *
 * The columns DID exist. The guard was `name in record.fields`, and Airtable
 * omits an empty field from a record entirely — so a column that has been
 * created and never written appears in NO record. Which is the state of every
 * column between repair-base adding it and the migration filling it: exactly
 * the window the migration runs in, and the only one it is for.
 *
 * migrate-first-worked had the same guard and escaped by luck, because the
 * writer had already been setting First Worked At on live saves by the time
 * anybody ran it.
 *
 * The fix is to ask the schema instead of the data, and the distinction this
 * file mostly exists to pin is the third state: columnsOf() returns null when
 * the PAT cannot read the schema, and null must NOT mean "missing" — a
 * migration that refused to run against a base it simply could not introspect
 * would be the same bug wearing a different hat.
 */
import { createServer } from 'node:http';

let failures = 0;
const check = (what, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n         got: ${JSON.stringify(got)}`}`);
};

/* A base with one contact that has a Name and nothing else — which is what a
   record looks like when every other column is empty. `declared` is what the
   metadata API says the table HOLDS, independent of what any row carries. */
let declared = ['Name', 'Kylas Contact ID', 'First Right POC At', 'First Discovery At'];
let metaStatus = 200;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (/\/meta\/bases\/[^/]+\/tables$/.test(url.pathname)) {
    if (metaStatus !== 200) { res.writeHead(metaStatus); return res.end('{"error":"forbidden"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ tables: [{
      id: 'tblContacts', name: 'Contacts',
      fields: declared.map((n) => ({ id: 'fld' + n.replace(/\W/g, ''), name: n, type: 'singleLineText' })),
    }] }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ records: [{ id: 'recA', fields: { Name: 'Devansh Shukla' } }] }));
});
await new Promise((r) => server.listen(0, r));
/* Before the import: airtable.mjs reads AIRTABLE_BASE_URL at module scope. */
process.env.AIRTABLE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
const { createAirtable, columnsOf, listTolerant } = await import('./airtable.mjs');
const at = createAirtable('pat_test', 'appT', { log: () => {} });

console.log('— a column that exists and is empty —');
{
  /* THE REPORTED BUG, as the two lines that produced it. */
  const rows = await listTolerant(at, 'Contacts', { fields: ['Name', 'First Right POC At'] });
  const fromRows = rows.some((r) => 'First Right POC At' in (r.fields || {}));
  check('no record carries it, because it is empty', fromRows, false);

  const cols = await columnsOf(at, 'Contacts');
  check('but the schema says it is there', cols?.has('First Right POC At'), true);
  check('and so is the other one', cols?.has('First Discovery At'), true);
}

console.log('\n— a column that genuinely is not there —');
{
  declared = ['Name', 'Kylas Contact ID'];
  const cols = await columnsOf(at, 'Contacts');
  check('the schema says so', cols?.has('First Right POC At'), false);
  /* The guard is `cols && !cols.has(name)` — a real Set that lacks the name. */
  check('which is a usable answer', !!cols, true);
}

console.log('\n— a PAT that cannot read the schema —');
{
  /* schema.bases:read is a separate scope, and plenty of working bases are
     driven by a token without it. NULL IS NOT "MISSING": a migration that
     treated it as absent would refuse to run on a base it simply could not
     look at, which is the same failure this file exists to prevent. */
  metaStatus = 403;
  const cols = await columnsOf(at, 'Contacts');
  check('it says "could not ask", not "not there"', cols, null);
  check('so the guard does not fire', !!(cols && !cols.has('First Right POC At')), false);
  metaStatus = 200;
}

console.log('\n— a table the base does not have at all —');
{
  declared = ['Name'];
  const cols = await columnsOf(at, 'Nonexistent');
  check('also null, for the same reason', cols, null);
}

server.close();

/* ── and the guards in the scripts themselves ─────────────────────────── */
console.log('\n— what the migrations actually test —');
{
  const { readFileSync } = await import('node:fs');
  for (const f of ['migrate-first-qualified', 'migrate-first-worked']) {
    const src = readFileSync(new URL(`./${f}.mjs`, import.meta.url), 'utf8');
    /* The old shape must not come back. It is a one-line change to make and it
       silently disables the migration on the only base it is meant for. */
    check(`${f} does not infer the schema from rows`,
          /\bin\s*\(r\.fields\s*\|\|\s*\{\}\)/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), false);
    check(`${f} asks columnsOf`, /columnsOf\(at,/.test(src), true);
    check(`${f} treats null as "could not ask"`, /cols\s*&&\s*!cols\.has|!cols\b/.test(src), true);
  }
}

/* ── every script a person runs by hand says which copy it is ─────────── */
console.log('\n— the build stamp —');
{
  /* A fix can be pushed, pulled into the wrong clone, and print the old
     message word for word. That happened on 2026-09-22 and cost an hour of
     looking at the wrong question — the output gave no way to tell. Anything
     run by hand names its branch, sha, dirty state and FOLDER, because this
     repo has been cloned more than once on that machine and "which commit"
     and "which directory" are different questions. */
  const { readFileSync } = await import('node:fs');
  const HAND_RUN = ['migrate-first-qualified', 'migrate-first-worked', 'migrate-ever-picked',
                    'seed-transitions', 'repair-base', 'verify-base'];
  for (const f of HAND_RUN) {
    const src = readFileSync(new URL(`./${f}.mjs`, import.meta.url), 'utf8');
    check(`${f} prints its build`, /buildLine\(\)/.test(src), true);
  }
  const { buildLine, build } = await import('./build.mjs');
  const b = build();
  check('the stamp names a folder', b.root, (r) => typeof r === 'string' && r.length > 1);
  check('and reads as one line', buildLine(), (t) => !/\n/.test(t) && t.length > 10);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
