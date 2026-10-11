// find-by-kind-tags (carried from entity-store) - remote finds by kind and tags, each with the store's
// position; and the client half's whole find, every match within one deadline (zorg's target, EM2, EM10; E2).
//
// With the call bound on a controlled clock: a find over more than one page with changes landing between its
// pages; every page's bound the time left, rounded down; the first page sent late; the bound passing before
// the first page, between pages, and while a page waits, and that page answering late; a later page ending
// refused, not delivered and unknown; the first page under the identity given and every later page under a new
// one, none marked a repeat; the JSON of a successful two-page find; finds as of positions 0, the current one,
// one below 0 and one above the current one; duplicate tags in a find; and a find by kind and tags.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTopology, until, within } from "../support/topology.js";
import { answerOf, clientOf, nodeEvidence, note, openStore, serve, T0 } from "../support/serving.js";

const PAD = 200_000;
const ID = "1791540000000-0123456789abcdef";

/**
 * A store of `count` entities of kind `any`, about 200 KB each, so a page holds two, served on host-a; hooks
 * run before and after the store answers each page, the nth page's hook by its number.
 */
async function setup(t, { count = 5, historyMs = 60_000, policy, evidence = nodeEvidence, bound = 1000 } = {}) {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const opened = openStore({ maxEntityBytes: 262_144, historyMs });
	for (let i = 1; i <= count; i++) opened.store.create({ kind: "any", name: `e${i}`, tags: ["t:x"], body: { pad: "x".repeat(PAD) } }, { writer: "seed", writeId: `seed-${i}` });
	const before = {};
	const after = {};
	let pages = 0;
	const store = {
		...Object.fromEntries(["create", "update", "delete", "read", "historyBound", "checkRepeat"].map((m) => [m, (...a) => opened.store[m](...a)])),
		find(input) {
			const n = ++pages;
			before[n]?.(input);
			const found = opened.store.find(input);
			after[n]?.(found);
			return found;
		},
	};
	await serve(topology, { store, evidence, ...(policy ? { policy } : {}) });
	const entry = topology.caller("alice");
	return { topology, entry, before, after, ...opened, client: clientOf(topology, "alice", { bound }), pagesServed: () => pages };
}

const names = (entries) => entries.map((e) => e.name);

test("a find over three pages answers every match as of its first page's position, though changes land between its pages; each later page is as of that position and after the last page's next", async (t) => {
	const { client, entry, store, after } = await setup(t);
	after[1] = () => {
		store.create({ kind: "any", name: "e0", tags: ["t:x"], body: 1 }, { writer: "w", writeId: "c1" });
		store.update({ target: { kind: "any", name: "e5" }, body: { pad: "changed" } }, { writer: "w", writeId: "c2" });
		store.delete({ target: { kind: "any", name: "e3" } }, { writer: "w", writeId: "c3" });
	};
	const ending = await within(client.find({ kind: "any", tags: ["t:x"] }, { invocation: ID }));
	const answer = answerOf(ending);
	assert.equal(answer.position, 5);
	assert.deepEqual(names(answer.entries), ["e1", "e2", "e3", "e4", "e5"]);
	assert.equal(answer.entries[4].body.pad.length, PAD, "e5 as it was at position 5");
	const pages = entry.calls;
	assert.equal(pages.length, 3);
	assert.deepEqual(pages.map((p) => p.input), [{ kind: "any", tags: ["t:x"] }, { kind: "any", tags: ["t:x"], asOf: 5, after: "e2" }, { kind: "any", tags: ["t:x"], asOf: 5, after: "e4" }]);
	assert.equal(pages[0].invocation, ID, "the first page under the identity given");
	assert.deepEqual([pages[1].invocation, pages[2].invocation], [undefined, undefined], "each later page under a new identity");
	const endings = await Promise.all(entry.endings);
	assert.equal(new Set(endings.map((e) => e.invocation)).size, 3);
	assert.ok(pages.every((p) => !("repeat" in p)), "no page is marked a repeat");
	assert.deepEqual([ending.invocation, ending.attempt], [ID, endings[0].attempt], "the find's identity is its first page's");
	assert.deepEqual(names(answerOf(await within(client.find({ kind: "any" }))).entries), ["e0", "e1", "e2", "e4", "e5"], "a find now sees the changes");
});

test("the JSON of a successful two-page find", async (t) => {
	const { client, entry, store } = await setup(t, { count: 3 });
	const ending = await within(client.find({ kind: "any" }, { invocation: ID }));
	const first = await entry.endings[0];
	const entries = [1, 2, 3].map((i) => store.read({ target: { kind: "any", name: `e${i}` } }).answer.entity);
	assert.equal(entry.calls.length, 2);
	assert.deepEqual(JSON.parse(JSON.stringify(ending)), { ending: "answered", invocation: ID, attempt: first.attempt, operation: "find", answer: { position: 3, entries } });
	assert.deepEqual(Object.keys(ending), ["ending", "invocation", "attempt", "operation", "answer"]);
	assert.deepEqual(Object.keys(ending.answer), ["position", "entries"]);
	assert.ok(Object.isFrozen(ending));
});

test("each page is invoked with the time left until the one deadline, rounded down to a whole millisecond", async (t) => {
	const { client, entry, topology, after } = await setup(t, { bound: 1000 });
	after[1] = () => topology.hooks.moveCallClock(100.7);
	after[2] = () => topology.hooks.moveCallClock(250.2);
	answerOf(await within(client.find({ kind: "any" })));
	assert.deepEqual(entry.calls.map((p) => p.bound), [1000, 899, 649]);
});

/** A clock over the topology's call clock that reads `offsets[i]` later at its i-th reading, the last offset holding. */
const steppingClock = (manual, offsets) => {
	let i = 0;
	return { now: () => manual.now() + offsets[Math.min(i++, offsets.length - 1)], schedule: (d, c) => manual.schedule(d, c) };
};

test("the first page sent late is invoked with only the time left of the find's bound", async (t) => {
	const { topology, entry } = await setup(t, { count: 1 });
	const client = clientOf(topology, "alice", { bound: 1000, clock: steppingClock(topology.manualClock, [0, 40.6]) });
	answerOf(await within(client.find({ kind: "any" })));
	assert.deepEqual(entry.calls.map((p) => p.bound), [959]);
});

test("the bound passing before the first page: no page is sent, and the find ends unknown at its bound with no AGP code and no delivery report, under the identity given or a new one", async (t) => {
	const { topology, entry } = await setup(t, { count: 1 });
	const identities = { wallTimeMs: () => 1791540000123.9, randomHex: (n) => "a".repeat(n) };
	for (const late of [1000, 1500, 999.5]) {
		const client = () => clientOf(topology, "alice", { bound: 1000, clock: steppingClock(topology.manualClock, [0, late]), identities });
		const given = await within(client().find({ kind: "any" }, { invocation: ID }));
		assert.deepEqual(given, { ending: "unknown", invocation: ID, attempt: null, operation: "find", reason: "bound-passed", agpCode: null, deliveryReport: null });
		assert.ok(Object.isFrozen(given));
		const made = await within(client().find({ kind: "any" }));
		assert.equal(made.invocation, "1791540000123-aaaaaaaaaaaaaaaa", "a new identity, as EM11 writes it");
		assert.equal(made.attempt, null);
	}
	assert.equal(entry.calls.length, 0, "no page was sent");
	const exactlyOne = clientOf(topology, "alice", { bound: 1000, clock: steppingClock(topology.manualClock, [0, 999]) });
	answerOf(await within(exactlyOne.find({ kind: "any" })));
	assert.deepEqual(entry.calls.map((p) => p.bound), [1], "with exactly 1 millisecond left a page is sent, bounded by it");
});

test("the bound passing between pages: no later page is sent, and the find ends unknown under its first page's identity", async (t) => {
	const { client, entry, topology, after } = await setup(t);
	after[1] = () => topology.hooks.moveCallClock(999.5);
	const ending = await within(client.find({ kind: "any" }, { invocation: ID }));
	const first = await entry.endings[0];
	assert.equal(first.ending, "answered", "the first page answered before the bound");
	assert.equal(entry.calls.length, 1);
	assert.deepEqual(ending, { ending: "unknown", invocation: ID, attempt: first.attempt, operation: "find", reason: "bound-passed", agpCode: null, deliveryReport: null });
});

test("the bound passing while a page waits ends the find as that page ended; the page answering late is discarded, and no further page is sent", async (t) => {
	const held = Promise.withResolvers();
	let requests = 0;
	const evidence = (delivery) => (delivery.destination === "store/find" && ++requests === 2 ? held.promise : nodeEvidence(delivery));
	const { client, entry, topology, pagesServed } = await setup(t, { evidence });
	const finding = client.find({ kind: "any" }, { invocation: ID });
	await until(() => requests === 2, "the second page reaching the host");
	topology.hooks.advanceCallClock(1000);
	const ending = await within(finding);
	const [first, second] = await Promise.all(entry.endings);
	assert.deepEqual([second.ending, second.reason, second.agpCode], ["unknown", "bound-passed", null]);
	assert.deepEqual(ending, { ...second, invocation: ID, attempt: first.attempt });
	const discarded = entry.caller.discarded();
	held.resolve(nodeEvidence({ source: { originNodeId: "alice" } }));
	await until(() => pagesServed() === 2 && entry.caller.discarded() === discarded + 1, "the late answer to be discarded");
	assert.equal(entry.calls.length, 2, "no page after the find ended");
	assert.deepEqual(ending, { ...second, invocation: ID, attempt: first.attempt }, "the ending is unchanged");
});

test("a later page ending refused ends the find refused, with that page's refusal, under the first page's identity", async (t) => {
	const { client, entry, store, setTime, after } = await setup(t, { historyMs: 1000 });
	after[1] = () => {
		setTime(T0 + 1000);
		store.create({ kind: "any", name: "late", tags: [], body: 1 }, { writer: "w", writeId: "c1" });
		setTime(T0 + 2000);
	};
	setTime(T0 + 500);
	const ending = await within(client.find({ kind: "any" }, { invocation: ID }));
	const [first, second] = await Promise.all(entry.endings);
	assert.equal(second.refusal.code, "position-not-held");
	assert.deepEqual(ending, { ending: "refused", invocation: ID, attempt: first.attempt, operation: "find", refusal: second.refusal });
});

test("a later page ending not delivered ends the find not delivered, with that page's AGP code, under the first page's identity", async (t) => {
	const { client, entry, after } = await setup(t);
	after[1] = () => entry.failNextSend("NO_ROUTE");
	const ending = await within(client.find({ kind: "any" }, { invocation: ID }));
	const [first, second] = await Promise.all(entry.endings);
	assert.deepEqual([second.ending, second.agpCode], ["not-delivered", "NO_ROUTE"]);
	assert.deepEqual(ending, { ending: "not-delivered", invocation: ID, attempt: first.attempt, operation: "find", agpCode: "NO_ROUTE", proxyCode: null, earlierAttemptsUncertain: false });
});

test("a later page ending unknown ends the find unknown, with that page's reason, AGP code and delivery report, under the first page's identity", async (t) => {
	const { client, entry, before } = await setup(t);
	before[2] = () => { throw new Error("the store failed"); };
	const ending = await within(client.find({ kind: "any" }));
	const [first, second] = await Promise.all(entry.endings);
	assert.deepEqual([second.ending, second.reason], ["unknown", "operation-failed"]);
	assert.deepEqual(ending, { ending: "unknown", invocation: first.invocation, attempt: first.attempt, operation: "find", reason: "operation-failed", agpCode: second.agpCode, deliveryReport: second.deliveryReport });
});

test("a whole find as of position 0, the current one, one below 0 and one above the current one", async (t) => {
	const { client } = await setup(t, { count: 2 });
	assert.deepEqual(answerOf(await within(client.find({ kind: "any", asOf: 0 }))), { position: 0, entries: [] });
	assert.deepEqual(names(answerOf(await within(client.find({ kind: "any", asOf: 2 }))).entries), ["e1", "e2"]);
	assert.deepEqual(names(answerOf(await within(client.find({ kind: "any", asOf: 1 }))).entries), ["e1"]);
	for (const asOf of [-1, 3]) {
		const ending = await within(client.find({ kind: "any", asOf }));
		assert.deepEqual([ending.ending, ending.refusal.code, ending.refusal.details], ["refused", "invalid-position", { position: asOf, current: 2 }]);
	}
});

test("a find returns every entity of its kind carrying every tag it names, and duplicate tags are one tag", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const { store } = openStore();
	await serve(topology, { store });
	const client = clientOf(topology, "alice");
	for (const [name, tags] of [["delta", ["p:a", "t:x"]], ["bravo", ["p:a", "t:x", "t:y"]], ["charlie", ["p:a"]], ["alpha", ["t:x"]]]) answerOf(await within(client.create(note(name, tags))));
	answerOf(await within(client.create({ kind: "any", name: "echo", tags: ["p:a", "t:x"], body: null })));
	const found = async (tags) => names(answerOf(await within(client.find({ kind: "note", ...(tags ? { tags } : {}) }))).entries);
	assert.deepEqual(await found(["p:a", "t:x"]), ["bravo", "delta"]);
	assert.deepEqual(await found(["t:x", "t:x"]), ["alpha", "bravo", "delta"]);
	assert.deepEqual(await found(["t:x"]), ["alpha", "bravo", "delta"]);
	assert.deepEqual(await found(["p:a", "p:a", "t:y", "t:y"]), ["bravo"]);
	assert.deepEqual(await found(), ["alpha", "bravo", "charlie", "delta"]);
	assert.equal(answerOf(await within(client.find({ kind: "note" }))).position, 5, "with the store's position");
	const page = answerOf(await within(client.findPage({ kind: "note", tags: ["t:x", "t:x"] })));
	assert.deepEqual([names(page.entries), page.next, page.position], [["alpha", "bravo", "delta"], null, 5]);
});

test("a whole find answers with its first page's position and every page's entries in order, whatever a later page states, through any caller offering the call layer's interface", async () => {
	const { createStoreClient } = await import("@apnex/entity-api");
	const pages = [
		{ position: 5, entries: [{ name: "a" }], next: "a" },
		{ position: 9, entries: [{ name: "b" }, { name: "c" }], next: "c" },
		{ position: 7, entries: [], next: null },
	];
	const asked = [];
	const caller = {
		async invoke(call) {
			asked.push(call);
			const invocation = call.invocation ?? `179154000000${asked.length}-0123456789abcdef`;
			return Object.freeze({ ending: "answered", invocation, attempt: `${invocation}.0000000${asked.length}`, operation: "find", answer: pages[asked.length - 1] });
		},
	};
	const client = createStoreClient({ caller, host: "host-a", service: "store", bound: 1000, clock: { now: () => 0 } });
	const ending = await client.find({ kind: "any" }, { invocation: ID });
	assert.deepEqual(ending, { ending: "answered", invocation: ID, attempt: `${ID}.00000001`, operation: "find", answer: { position: 5, entries: [{ name: "a" }, { name: "b" }, { name: "c" }] } });
	assert.deepEqual(asked.map((c) => [c.input, c.bound, c.invocation]), [[{ kind: "any" }, 1000, ID], [{ kind: "any", asOf: 5, after: "a" }, 1000, undefined], [{ kind: "any", asOf: 5, after: "c" }, 1000, undefined]]);
});
