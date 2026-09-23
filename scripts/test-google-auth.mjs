#!/usr/bin/env node
/* Can anything but a genuine Google token for a genuine Enout address get in?
 *
 *   node scripts/test-google-auth.mjs
 *
 * Mints its own RSA keys and signs its own tokens, so every forgery below is
 * actually attempted against the real verifier rather than described. No
 * network, no mocks of Google — the signature maths is the same maths.
 *
 * THIS IS THE SUITE THAT MATTERS MOST IN THE REPO. Everything else protects a
 * number on a dashboard. This protects the Kylas key and the Airtable token
 * from anyone who finds the address, and every way of getting it wrong looks
 * exactly like working code from the outside: the happy path passes either way.
 */
import { createGoogleAuth } from './google-auth.mjs';

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
const enc = new TextEncoder();
const b64url = (bytes) => Buffer.from(bytes).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* Two key pairs: the one the verifier will trust, and one an attacker has. */
const gen = () => crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify']);
const google = await gen();
const attacker = await gen();

const jwkFor = async (pair, kid) => ({
  ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' });

/* Stands in for https://www.googleapis.com/oauth2/v3/certs. */
let jwksHits = 0;
const jwks = { keys: [await jwkFor(google, 'k1')] };
const fetchImpl = async () => { jwksHits++; return { ok: true, json: async () => jwks }; };

const SECOND = 1000;
let clock = Date.UTC(2026, 8, 23, 12, 0, 0);
const now = () => clock;

async function sign(claims, { pair = google, kid = 'k1', alg = 'RS256' } = {}) {
  const header = b64url(enc.encode(JSON.stringify({ alg, kid, typ: 'JWT' })));
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const good = (over = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '100000000000000000001',
  email: 'ayush@enout.in',
  email_verified: true,
  name: 'Ayush Tiwari',
  iat: Math.floor(clock / 1000) - 10,
  exp: Math.floor(clock / 1000) + 3600,
  ...over,
});

const auth = createGoogleAuth({ clientId: CLIENT_ID, allowedDomain: 'enout.in',
                                fetchImpl, now, log: () => {} });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : fail++); console.log(`${ok ? '  PASS' : '! FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/* Every one of these MUST be rejected. A test that asserts a rejection passes
   just as happily when the verifier is broken in some other way, so each one
   names what it is really about. */
const rejects = async (name, token, because) => {
  try {
    const who = await auth.verify(token);
    check(name, false, `LET IN as ${who.email} — ${because}`);
  } catch (e) {
    check(name, e.authFailure === true, e.authFailure ? e.message : `threw the wrong kind: ${e.message}`);
  }
};

console.log('\n1. a real token from a real Enout address');
const who = await auth.verify(await sign(good()));
check('is accepted', who.email === 'ayush@enout.in', JSON.stringify(who));
check('and the keys were fetched once, then cached', jwksHits === 1, `${jwksHits} fetch(es)`);
await auth.verify(await sign(good({ email: 'priya@enout.in' })));
check('a second verify does not refetch', jwksHits === 1, `${jwksHits} fetch(es)`);

console.log('\n2. forgery');
await rejects('a token signed with somebody else\'s key',
  await sign(good(), { pair: attacker }),
  'the signature is the only thing making any other claim meaningful');
/* The alg:none family. The header is attacker-controlled, so a verifier that
   believes it can be told not to check anything at all. */
const noneToken = `${b64url(enc.encode(JSON.stringify({ alg: 'none', kid: 'k1', typ: 'JWT' })))}.${b64url(enc.encode(JSON.stringify(good())))}.`;
await rejects('a token claiming alg:none', noneToken, 'the classic JWT forgery');
await rejects('a token with a tampered payload',
  await (async () => {
    const t = await sign(good());
    const [h, , s] = t.split('.');
    return `${h}.${b64url(enc.encode(JSON.stringify(good({ email: 'attacker@enout.in' }))))}.${s}`;
  })(),
  'swapping the body while keeping a valid-looking signature');
await rejects('a token naming a signing key that does not exist',
  await sign(good(), { kid: 'not-a-real-kid' }),
  'and it must not refetch Google on every such request');
check('a bogus kid refetched at most once', jwksHits <= 2, `${jwksHits} fetch(es)`);

console.log('\n3. a genuine Google token — for somebody else\'s application');
/* THE CHECK PEOPLE FORGET. Google signs tokens for millions of apps with these
   same keys. Without `aud`, someone's login to any unrelated service is a
   valid credential here. */
await rejects('a valid token issued to a different app',
  await sign(good({ aud: '999-someoneelse.apps.googleusercontent.com' })),
  'aud is the only thing saying this token was minted for us');
await rejects('a token from an issuer that is not Google',
  await sign(good({ iss: 'https://accounts.evil.example' })),
  'iss');

console.log('\n4. time');
await rejects('an expired token', await sign(good({ exp: Math.floor(clock / 1000) - 120 })),
  'a token leaked last year must not still work');
const stillFresh = await sign(good({ exp: Math.floor(clock / 1000) + 30 }));
check('60s of clock skew is tolerated', !!(await auth.verify(stillFresh)));
clock += 3600 * SECOND;                       /* an hour passes */
await rejects('and it stops working once it is really expired', stillFresh, 'exp + slack');
clock -= 3600 * SECOND;

console.log('\n5. who the person is');
await rejects('an unverified email address', await sign(good({ email_verified: false })),
  'an unverified address is one the account holder typed, not one Google checked');
await rejects('a gmail address', await sign(good({ email: 'someone@gmail.com' })), 'wrong domain');
/* THE endsWith BUG. "notenout.in" is a domain anyone can register, and
   "evil@notenout.in".endsWith("enout.in") is true. */
await rejects('an address at a domain that merely ENDS in enout.in',
  await sign(good({ email: 'evil@notenout.in' })),
  'this is why the domain is compared after splitting on @, not with endsWith');
await rejects('an address with the domain in the wrong place',
  await sign(good({ email: 'enout.in@gmail.com' })), 'the @ is what counts');
await rejects('a token carrying no email at all', await sign(good({ email: undefined })), 'no identity');

console.log('\n6. nonsense');
for (const [name, token] of [['empty', ''], ['not a JWT', 'hello'],
                             ['two segments', 'a.b'], ['garbage segments', '!!.??.$$']])
  await rejects(`${name} is refused`, token, 'must not throw an unhandled error');

console.log('\n7. a named allow-list instead of a domain');
const listed = createGoogleAuth({ clientId: CLIENT_ID, allowedEmails: ['contractor@gmail.com'],
                                  fetchImpl, now });
check('a listed outsider is let in',
  (await listed.verify(await sign(good({ email: 'contractor@gmail.com' })))).email === 'contractor@gmail.com');
try {
  await listed.verify(await sign(good({ email: 'ayush@enout.in' })));
  check('an unlisted address is refused', false, 'LET IN');
} catch (e) { check('an unlisted address is refused', e.authFailure === true, e.message); }

console.log('\n8. a configuration that would let everyone in');
/* Refusing to start is the right answer. A server that runs with no rule about
   who may call it is worse than one that will not boot, because it looks fine. */
for (const [name, cfg] of [
  ['no clientId', { allowedDomain: 'enout.in' }],
  ['no domain and no list', { clientId: CLIENT_ID }],
]) {
  try { createGoogleAuth(cfg); check(`${name} is refused at construction`, false, 'it built one anyway'); }
  catch (e) { check(`${name} is refused at construction`, /needs/.test(e.message), e.message); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
