#!/usr/bin/env node
/* The save queue: does it keep a contact's saves in order, run each once, retry
 * what is worth retrying and give up on what is not?
 *
 *   node scripts/test-save-queue.mjs
 *
 * Real SQL over real SQLite (d1-fake.mjs); the "perform" function stands in for
 * the Kylas + Airtable save so each failure mode can be chosen.
 */
import { createSaveQueue } from "./save-queue.mjs";
import { fakeD1 } from "./d1-fake.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? "  PASS" : "! FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let clock = Date.now();
const now = () => clock;
const db = fakeD1();
const A = createSaveQueue({ db, now });
const B = createSaveQueue({ db, now });          /* a second instance, same database */

console.log("\n1. a save is done once, and reports what it did");
const ran = [];
const ok = async (body) => { ran.push(body.n); return { kid: `k${body.n}`, n: body.n }; };
const j1 = await A.enqueue("lid:a", { n: 1 });
await A.run(j1, ok);
let st = await B.status([j1]);
check("it ran", ran.join() === "1");
check("and its result is readable from another instance", st[j1].state === "done" && st[j1].result.kid === "k1",
      JSON.stringify(st[j1]));
await A.run(j1, ok);
check("running it again does nothing", ran.join() === "1");

console.log("\n2. one contact, in order, one at a time");
ran.length = 0;
let release;
const gate = new Promise((r) => { release = r; });
const slow = async (body) => { ran.push(`start${body.n}`); if (body.n === 2) await gate; ran.push(`end${body.n}`); return { n: body.n }; };
const j2 = await A.enqueue("lid:b", { n: 2 });
const j3 = await A.enqueue("lid:b", { n: 3 });
const j4 = await A.enqueue("lid:c", { n: 4 });  /* a different contact */
const pA = A.run(j2, slow);
await sleep(10);
await B.run(j3, slow);                           /* another instance tries the next save of the SAME contact */
check("a later save of the same contact waits while an earlier one runs", !ran.includes("start3"), ran.join());
await B.run(j4, slow);
check("a different contact does not wait", ran.includes("end4"), ran.join());
release();
await pA;
check("the waiting save runs as soon as the earlier one finishes", ran.indexOf("end2") < ran.indexOf("start3") && ran.includes("end3"),
      ran.join());

console.log("\n3. two instances, one job");
ran.length = 0;
const j5 = await A.enqueue("lid:d", { n: 5 });
await Promise.all([A.run(j5, ok), B.run(j5, ok), A.run(j5, ok)]);
check("claimed and run exactly once", ran.join() === "5", ran.join());

console.log("\n4. a network failure is retried, and holds the contact's later saves");
let flaky = 1;
const net = async (body) => {
  if (body.n === 6 && flaky-- > 0) throw Object.assign(new Error("Kylas 503"), { status: 503 });
  ran.push(body.n); return { n: body.n };
};
ran.length = 0;
const j6 = await A.enqueue("lid:e", { n: 6 });
const j7 = await A.enqueue("lid:e", { n: 7 });
await A.run(j6, net);
await A.run(j7, net);
st = await A.status([j6, j7]);
check("the failed save is queued again, with when", st[j6].state === "queued" && !!st[j6].retryAt && st[j6].tries === 1,
      JSON.stringify(st[j6]));
check("the next save of that contact did not jump ahead", st[j7].state === "queued" && !ran.includes(7));
let d = await A.drain(net);
check("the maintenance run leaves it alone until it is due", !ran.length, JSON.stringify(d));
clock += 61e3;
d = await A.drain(net);
st = await A.status([j6, j7]);
check("once due, the retry runs and so does the save behind it", st[j6].state === "done" && st[j7].state === "done"
      && ran.join() === "6,7", `${ran.join()} ${JSON.stringify(d)}`);

console.log("\n5. a rejection is final");
const reject = async () => { throw Object.assign(new Error("phone is invalid"), { status: 422, problems: [{ why: "phone" }] }); };
const j8 = await A.enqueue("lid:f", { n: 8 });
await A.run(j8, reject);
st = await A.status([j8]);
check("marked dead, with Kylas' reason", st[j8].state === "dead" && /phone/.test(st[j8].error.message), JSON.stringify(st[j8]));
const j9 = await A.enqueue("lid:f", { n: 9 });
ran.length = 0;
await A.run(j9, ok);
check("and does not block the contact's next save", ran.join() === "9");
const j10 = await A.enqueue("lid:g", { n: 10 });
await A.run(j10, async () => { throw Object.assign(new Error("slow down"), { status: 429 }); });
check("429 is not a rejection — it is retried", (await A.status([j10]))[j10].state === "queued");

console.log("\n6. a run that was cut off");
ran.length = 0;
const j11 = await A.enqueue("lid:h", { n: 11 });
await db.prepare("UPDATE save_jobs SET state = 'running', lease_until = ?, tries = 1 WHERE id = ?").bind(clock + 180e3, j11).run();
await A.drain(ok);
check("is left alone while its lease holds", !ran.length);
clock += 181e3;
await A.drain(ok);
check("and taken over once it has lapsed", ran.includes(11) && (await A.status([j11]))[j11].state === "done", ran.join());

console.log("\n7. giving up");
const always = async () => { throw Object.assign(new Error("down"), { status: 502 }); };
const j12 = await A.enqueue("lid:i", { n: 12 });
for (let i = 0; i < 12; i++) { await A.drain(always); clock += 7 * 3600e3; }
st = await A.status([j12]);
check("after the last retry it stops and says so", st[j12].state === "dead" && st[j12].tries === 7, JSON.stringify(st[j12]));
check("the backlog counts it", (await A.backlog()).dead >= 2, JSON.stringify(await A.backlog()));
check("an unknown id is reported as such", (await A.status(["nope"])).nope.state === "unknown");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
