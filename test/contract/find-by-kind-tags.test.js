// find-by-kind-tags (carried from entity-store) - remote finds by kind and tags, each with the store's
// position; and the client half's whole find, every match within one deadline (zorg's target, EM2, EM10; E2).
//
// With the call bound on a controlled clock: a find over more than one page with changes landing between its
// pages; every page's bound the time left, rounded down; the first page sent late; the bound passing before
// the first page, between pages, and while a page waits, and that page answering late; a later page ending
// refused, not delivered and unknown; the first page under the identity given and every later page under a new
// one, none marked a repeat; the JSON of a successful two-page find; finds as of positions 0, the current one,
// one below 0 and one above the current one; duplicate tags in a find; and a find by kind and tags.
// After the verifications (EM10 as revised): the find's clock read as it is called, then its input and options
// read once, into a snapshot, the time that takes spent from its bound - time passing in their getters, a slow
// signal, bound or input getter using the bound up before the first page, as findPage ends for the same input,
// time passing in the first and a later page's preparation, and a final page that cannot be accepted; deep
// JSON, cycles, aliases and getters in a whole find's input; the abort signal reaching every page; and a page
// whose answer is not a page, first or later, ending the find answered with that answer unchanged under the
// first page's invocation and attempt.
// The single calls (EM10 as revised), findPage, a write and a read, read their clock as they are called, as
// the whole find does: a slow signal, bound, invocation or input getter spending all the bound, or leaving less
// than 1 millisecond, ends the call unknown with bound-passed, whole and frozen, with nothing handed to the call
// layer, under the identity given or a new one and a new attempt identity of it; spending part of the bound, it
// leaves the call layer exactly the time left, rounded down; a programming error found once the bound has
// passed is still thrown; and the find and findPage end alike for the same preparation, but for their attempts.
// An abort signal given that is not one (EM12, EM10) - null, one without aborted, one whose aborted is not a
// boolean - is thrown as a TypeError by findPage, a write, a read and the whole find, with time left and once a
// slow invocation getter has spent the bound, nothing handed to the call layer; a genuine signal and none given
// as controls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStoreClient } from "@apnex/entity-api";
import { createOperationHost } from "@apnex/operation-call";
import { openTopology, preparingIdentities, until, within } from "../support/topology.js";
import { createManualCallClock } from "../support/manual-call-clock.js";
import { answerOf, clientOf, nodeEvidence, note, openStore, serve, T0 } from "../support/serving.js";

const PAD = 200_000;
const ID = "1791540000000-0123456789abcdef";

/**
 * A store of `count` entities of kind `any`, about 200 KB each, so a page holds two, served on host-a; hooks
 * run before and after the store answers each page, the nth page's hook by its number.
 */
async function setup(t, { count = 5, historyMs = 60_000, policy, evidence = nodeEvidence, bound = 1000, identities } = {}) {
	const topology = await openTopology({ callers: ["alice"], ...(identities ? { identities } : {}) });
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

/** A caller answering each page with the given answers in turn, through a manual clock; `during[n]` runs as the nth page is answered. */
function scriptedCaller(answers, during = {}) {
	const asked = [];
	return {
		asked,
		caller: {
			async invoke(call) {
				asked.push(call);
				const n = asked.length;
				during[n]?.(call);
				const invocation = call.invocation ?? `179154000000${n}-0123456789abcdef`;
				return Object.freeze({ ending: "answered", invocation, attempt: `${invocation}.0000000${n}`, operation: "find", answer: answers[n - 1] });
			},
		},
	};
}

test("the find reads its clock as it is called, then its input and options once, into a snapshot: time passing in their getters is spent from its bound", async (t) => {
	const { client, entry, topology } = await setup(t, { count: 3 });
	const reads = { bound: 0, invocation: 0, signal: 0, kind: 0 };
	const signal = new AbortController().signal;
	const options = {
		get bound() { reads.bound++; topology.hooks.moveCallClock(100); return 1000; },
		get invocation() { reads.invocation++; topology.hooks.moveCallClock(100); return ID; },
		get signal() { reads.signal++; topology.hooks.moveCallClock(100); return signal; },
	};
	const input = { get kind() { reads.kind++; topology.hooks.moveCallClock(100.5); return "any"; } };
	const ending = await within(client.find(input, options));
	assert.deepEqual(names(answerOf(ending).entries), ["e1", "e2", "e3"]);
	assert.deepEqual(reads, { bound: 1, invocation: 1, signal: 1, kind: 1 }, "each getter read once");
	assert.deepEqual(entry.calls.map((p) => p.bound), [599, 599], "the 400.5 ms spent reading them taken from the one bound, read as the find was called");
	assert.deepEqual(entry.calls.map((p) => [p.input.kind, p.signal === signal]), [["any", true], ["any", true]]);
	assert.equal(ending.invocation, ID);
});

test("a slow signal getter, a slow bound getter or a slow input getter that uses the bound up ends the find unknown at its bound, attempt null, under the identity given or a new one, with no page sent, as findPage ends for the same input", async (t) => {
	const { topology, entry, pagesServed } = await setup(t, { count: 3 });
	const identities = { wallTimeMs: () => 1791540000123.9, randomHex: (n) => "b".repeat(n) };
	const client = clientOf(topology, "alice", { bound: 10, identities });
	const slow = (ms, value) => { topology.hooks.moveCallClock(ms); return value; };
	const preparations = {
		signal: (ms, given = {}) => [{ kind: "any" }, { ...given, get signal() { return slow(ms, undefined); } }],
		bound: (ms, given = {}) => [{ kind: "any" }, { ...given, get bound() { return slow(ms, 10); } }],
		input: (ms, given = {}) => [{ get kind() { return slow(ms, "any"); } }, given],
	};
	for (const [what, prepare] of Object.entries(preparations)) {
		const given = await within(client.find(...prepare(20, { invocation: ID })));
		assert.deepEqual(given, { ending: "unknown", invocation: ID, attempt: null, operation: "find", reason: "bound-passed", agpCode: null, deliveryReport: null }, `${what}: under the identity given`);
		assert.ok(Object.isFrozen(given));
		const made = await within(client.find(...prepare(20)));
		assert.deepEqual([made.ending, made.reason, made.invocation, made.attempt], ["unknown", "bound-passed", "1791540000123-bbbbbbbbbbbbbbbb", null], `${what}: under a new identity`);
		const edge = await within(client.find(...prepare(9.5)));
		assert.deepEqual([edge.ending, edge.reason, edge.attempt], ["unknown", "bound-passed", null], `${what}: less than 1 ms left`);
	}
	assert.equal(entry.calls.length, 0, "no page was sent");
	const page = await within(client.findPage(...preparations.input(20)));
	assert.deepEqual([page.ending, page.reason], ["unknown", "bound-passed"], "findPage ends at its bound for the same input");
	assert.equal(entry.calls.length, 0, "nothing handed to the call layer for findPage either");
	answerOf(await within(client.find(...preparations.input(9))));
	assert.deepEqual(entry.calls.map((p) => p.bound), [1, 1], "with exactly 1 ms left, each page is sent, bounded by what is left");
	assert.equal(pagesServed(), 2);
});

/** EM11's attempt identity. */
const ATTEMPT = /^[0-9]{13}-[0-9a-f]{16}\.[0-9a-f]{8}$/;

/** An identity source whose random digits count up, so each identity the client makes is known: `ahead(i, n)` is what the ith next randomHex(n) gives. */
function countingIdentities() {
	let k = 0;
	const hex = (i, n) => i.toString(16).padStart(n, "0");
	return { source: { wallTimeMs: () => 1791540000123.9, randomHex: (n) => hex(++k, n) }, ahead: (i, n) => hex(k + i, n) };
}

/** The single calls driven here - findPage, a write and a read - each with the operation it invokes and a fresh input. */
const SINGLES = {
	findPage: { operation: "find", call: (c, input, o) => c.findPage(input, o), input: () => ({ kind: "any", tags: ["t:x"] }) },
	create: { operation: "create", call: (c, input, o) => c.create(input, o), input: (n) => ({ kind: "any", name: `made-${n}`, tags: [], body: n }) },
	read: { operation: "read", call: (c, input, o) => c.read(input, o), input: () => ({ target: { kind: "any", name: "e1" } }) },
};

/**
 * Preparations of a call in which one getter of the caller's spends `ms` on the call clock as it is read - the
 * signal's, the bound's, the invocation's, or the input's first field's - naming `invocation`, or none when it
 * is undefined, and the client's bound. `reads.n` counts the slow getter's reads.
 */
const slowGetters = (move, reads = { n: 0 }) => {
	const slow = (ms, value) => { reads.n++; move(ms); return value; };
	const named = (invocation) => (invocation === undefined ? {} : { invocation });
	const slowFirst = (input, ms) => {
		const [first] = Object.keys(input);
		const value = input[first];
		return Object.defineProperty({ ...input }, first, { get: () => slow(ms, value), enumerable: true });
	};
	return {
		signal: (input, ms, invocation) => [input, { ...named(invocation), get signal() { return slow(ms, undefined); } }],
		bound: (input, ms, invocation) => [input, { ...named(invocation), get bound() { return slow(ms, 10); } }],
		invocation: (input, ms, invocation) => [input, { get invocation() { return slow(ms, invocation); } }],
		input: (input, ms, invocation) => [slowFirst(input, ms), named(invocation)],
	};
};

/** The ending a call whose bound passed with nothing sent is given, whole, as the call layer's caller gives it. */
const passed = (operation, invocation, attempt) => ({ ending: "unknown", invocation, attempt, operation, reason: "bound-passed", agpCode: null, deliveryReport: null });

test("findPage, a write and a read each read their clock as they are called: a slow signal, bound, invocation or input getter spending the bound, or leaving less than 1 ms, ends the call unknown at its bound, nothing handed to the call layer, under the identity given or a new one, with a new attempt identity of it", async (t) => {
	const { topology, entry, store, pagesServed } = await setup(t, { count: 3 });
	const ids = countingIdentities();
	const client = clientOf(topology, "alice", { bound: 10, identities: ids.source });
	const preparations = slowGetters((ms) => topology.hooks.moveCallClock(ms));
	let n = 0;
	for (const [name, single] of Object.entries(SINGLES)) {
		for (const [what, prepare] of Object.entries(preparations)) {
			for (const ms of [20, 10, 9.5]) {
				for (const given of [ID, undefined]) {
					const label = `${name}, a slow ${what} getter spending ${ms} of 10 ms, ${given === undefined ? "no identity given" : "the identity given"}`;
					const invocation = given ?? `1791540000123-${ids.ahead(1, 16)}`;
					const attempt = `${invocation}.${ids.ahead(given === undefined ? 2 : 1, 8)}`;
					const ending = await within(single.call(client, ...prepare(single.input(++n), ms, given)));
					assert.deepEqual(ending, passed(single.operation, invocation, attempt), label);
					assert.deepEqual(Object.keys(ending), ["ending", "invocation", "attempt", "operation", "reason", "agpCode", "deliveryReport"], label);
					assert.match(ending.attempt, ATTEMPT, `${label}: an attempt identity as EM11 writes it`);
					assert.ok(Object.isFrozen(ending), label);
					assert.equal(entry.calls.length, 0, `${label}: nothing handed to the call layer`);
				}
			}
		}
	}
	assert.equal(pagesServed(), 0, "no page reached the store");
	assert.equal(store.historyBound().answer.position, 3, "nothing was written");
});

test("findPage, a write and a read each spend from their bound the time a slow signal, bound, invocation or input getter takes: the call layer is given exactly the time left, rounded down, and its ending is returned unchanged", async (t) => {
	const { topology, entry } = await setup(t, { count: 3 });
	const client = clientOf(topology, "alice", { bound: 10 });
	const reads = { n: 0 };
	const preparations = slowGetters((ms) => topology.hooks.moveCallClock(ms), reads);
	let n = 0;
	for (const [name, single] of Object.entries(SINGLES)) {
		for (const [what, prepare] of Object.entries(preparations)) {
			for (const [ms, bound] of [[3.4, 6], [9, 1]]) {
				for (const given of [entry.caller.newInvocation(), undefined]) {
					const label = `${name}, a slow ${what} getter spending ${ms} of 10 ms, ${given === undefined ? "no identity given" : "the identity given"}`;
					const before = entry.calls.length;
					reads.n = 0;
					const ending = await within(single.call(client, ...prepare(single.input(++n), ms, given)));
					assert.equal(reads.n, 1, `${label}: the getter read once, into the snapshot the call layer is given`);
					assert.equal(entry.calls.length, before + 1, `${label}: one invocation`);
					const made = entry.calls.at(-1);
					assert.deepEqual({ ...made, signal: undefined }, { host: "host-a", service: "store", operation: single.operation, input: single.input(n), bound, ...(given === undefined ? {} : { invocation: given }), signal: undefined }, label);
					assert.equal(ending, await entry.endings.at(-1), `${label}: the call layer's ending, unchanged`);
					assert.equal(ending.ending, "answered", label);
					if (given !== undefined) assert.equal(ending.invocation, given, label);
				}
			}
		}
	}
});

test("a programming error a single call or a whole find finds once its bound has passed is still thrown, and nothing is sent", async (t) => {
	const { topology, entry } = await setup(t, { count: 3 });
	const client = clientOf(topology, "alice", { bound: 10 });
	const late = () => topology.hooks.moveCallClock(20);
	const cyclic = (input) => { const value = { ...input, get extra() { late(); return value; } }; return value; };
	const errors = [
		["a bound not whole", RangeError, (input) => [input, { get bound() { late(); return 1.5; } }]],
		["a bound out of range", RangeError, (input) => [input, { bound: 0, get signal() { late(); return undefined; } }]],
		["an invocation not as EM11 writes it", TypeError, (input) => [input, { get invocation() { late(); return "not-an-identity"; } }]],
		["an input that is not a JSON value", TypeError, (input) => [{ ...input, get extra() { late(); return () => 1; } }, {}]],
		["an input holding itself", TypeError, (input) => [cyclic(input), {}]],
		["an input whose getter throws", TypeError, (input) => [{ ...input, get extra() { late(); throw new Error("a getter that throws"); } }, {}]],
	];
	const calls = { ...SINGLES, find: { call: (c, input, o) => c.find(input, o), input: () => ({ kind: "any" }) } };
	let n = 0;
	for (const [name, single] of Object.entries(calls)) {
		for (const [what, type, prepare] of errors) await assert.rejects(single.call(client, ...prepare(single.input(++n))), type, `${name}, ${what}`);
	}
	await assert.rejects(client.create(SINGLES.create.input(++n), { repeat: "yes", get signal() { late(); return undefined; } }), TypeError, "a write's repeat flag that is not a boolean");
	assert.equal(entry.calls.length, 0, "nothing was sent");
});

test("an abort signal given that is not one - null, one without aborted, one whose aborted is not a boolean - is a programming error findPage, a write, a read and the whole find each throw, with time left and once a slow invocation getter has spent the whole bound, nothing handed to the call layer; a genuine signal and none given are not", async (t) => {
	const { topology, entry } = await setup(t, { count: 3 });
	const client = clientOf(topology, "alice", { bound: 10 });
	const calls = { ...SINGLES, find: { operation: "find", call: (c, input, o) => c.find(input, o), input: () => ({ kind: "any" }) } };
	const malformed = [["a null signal", null], ["a signal without aborted", {}], ["a signal whose aborted is not a boolean", { aborted: 0 }]];
	const controls = [["a genuine signal", new AbortController().signal], ["none given", undefined]];
	const prepared = (spend, signal) => ({ get invocation() { if (spend) topology.hooks.moveCallClock(spend); return undefined; }, signal });
	let n = 0;
	for (const [name, single] of Object.entries(calls)) {
		for (const spend of [0, 10, 20]) {
			const when = spend === 0 ? "with time left" : `a getter spending ${spend} of 10 ms`;
			for (const [what, signal] of malformed) {
				const before = entry.calls.length;
				await assert.rejects(within(single.call(client, single.input(++n), prepared(spend, signal))), TypeError, `${name}, ${what}, ${when}`);
				assert.equal(entry.calls.length, before, `${name}, ${what}, ${when}: nothing handed to the call layer`);
			}
			for (const [what, signal] of controls) {
				const before = entry.calls.length;
				const ending = await within(single.call(client, single.input(++n), prepared(spend, signal)));
				if (spend === 0) {
					assert.ok(entry.calls.length > before, `${name}, ${what}, ${when}: handed to the call layer`);
					assert.equal(entry.calls.at(-1).signal, signal, `${name}, ${what}, ${when}: the signal handed on as given`);
					assert.equal(ending.ending, "answered", `${name}, ${what}, ${when}`);
				} else {
					assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"], `${name}, ${what}, ${when}`);
					assert.equal(entry.calls.length, before, `${name}, ${what}, ${when}: nothing handed to the call layer`);
				}
			}
		}
	}
});

test("a whole find and findPage end bound-passed alike for the same slow signal, bound, invocation or input getter, the find with attempt null, findPage with a new attempt identity, under the identity given or a new one", async (t) => {
	const { topology, entry } = await setup(t, { count: 3 });
	const ids = countingIdentities();
	const client = clientOf(topology, "alice", { bound: 10, identities: ids.source });
	for (const [what, prepare] of Object.entries(slowGetters((ms) => topology.hooks.moveCallClock(ms)))) {
		for (const given of [ID, undefined]) {
			const label = `a slow ${what} getter, ${given === undefined ? "no identity given" : "the identity given"}`;
			const wholeInvocation = given ?? `1791540000123-${ids.ahead(1, 16)}`;
			const whole = await within(client.find(...prepare({ kind: "any" }, 20, given)));
			assert.deepEqual(whole, passed("find", wholeInvocation, null), `the find, ${label}`);
			const pageInvocation = given ?? `1791540000123-${ids.ahead(1, 16)}`;
			const page = await within(client.findPage(...prepare({ kind: "any" }, 20, given)));
			assert.deepEqual(page, passed("find", pageInvocation, `${pageInvocation}.${ids.ahead(0, 8)}`), `findPage, ${label}`);
			assert.deepEqual({ ...whole, invocation: "", attempt: "" }, { ...page, invocation: "", attempt: "" }, `${label}: the same ending but for its identities`);
		}
	}
	assert.equal(entry.calls.length, 0, "nothing was handed to the call layer");
});

test("time passing while the call layer prepares the first page, or a later one, is taken from that page's bound: the find ends unknown, no page is answered after its deadline, and nothing further is sent", async (t) => {
	for (const page of [1, 2]) {
		const { source, hooks } = preparingIdentities();
		const { client, entry, topology, pagesServed } = await setup(t, { count: 3, identities: source });
		hooks.attempt = (n) => { if (n === page) topology.hooks.moveCallClock(1000); };
		const ending = await within(client.find({ kind: "any" }, { invocation: ID }));
		const endings = await Promise.all(entry.endings);
		assert.equal(entry.calls.length, page, `page ${page}: invoked`);
		assert.deepEqual([endings[page - 1].ending, endings[page - 1].reason], ["unknown", "bound-passed"], `page ${page} ended at its bound`);
		assert.equal(pagesServed(), page - 1, `page ${page} was never sent`);
		assert.deepEqual(ending, { ...endings[page - 1], invocation: ID, attempt: endings[0].attempt });
	}
});

test("time passing while a later page is prepared from the last page's answer is read before that page's bound", async () => {
	const clock = createManualCallClock(0);
	const reads = { position: 0, entries: 0, next: 0 };
	const first = {
		get position() { reads.position++; clock.move(100); return 4; },
		get entries() { reads.entries++; clock.move(100); return [{ name: "a" }]; },
		get next() { reads.next++; clock.move(100.5); return "a"; },
	};
	const { caller, asked } = scriptedCaller([first, { position: 4, entries: [{ name: "b" }], next: null }]);
	const client = createStoreClient({ caller, host: "host-a", service: "store", bound: 1000, clock });
	const ending = await client.find({ kind: "any" }, { invocation: ID });
	assert.deepEqual(answerOf(ending), { position: 4, entries: [{ name: "a" }, { name: "b" }] });
	assert.deepEqual(reads, { position: 1, entries: 1, next: 1 }, "each field of the answer read once");
	assert.deepEqual(asked.map((c) => c.bound), [1000, 699], "the later page given only what was left after its preparation");
});

test("a final page that cannot be accepted - its answer coming once the find's deadline has passed - ends the find unknown at its bound, not answered", async (t) => {
	const { client, entry, topology, after } = await setup(t, { count: 3 });
	after[2] = () => topology.hooks.moveCallClock(1000);
	const ending = await within(client.find({ kind: "any" }, { invocation: ID }));
	const [firstPage, second] = await Promise.all(entry.endings);
	assert.deepEqual([second.ending, second.reason], ["unknown", "bound-passed"], "the call layer did not take the final page's answer");
	assert.deepEqual(ending, { ...second, invocation: ID, attempt: firstPage.attempt });

	const clock = createManualCallClock(0);
	const { caller, asked } = scriptedCaller([{ position: 4, entries: [{ name: "a" }], next: "a" }, { position: 4, entries: [], next: null }], { 2: () => clock.move(1000) });
	const late = await createStoreClient({ caller, host: "host-a", service: "store", bound: 1000, clock }).find({ kind: "any" }, { invocation: ID });
	assert.equal(asked.length, 2);
	assert.deepEqual(late, { ending: "unknown", invocation: ID, attempt: `${ID}.00000001`, operation: "find", reason: "bound-passed", agpCode: null, deliveryReport: null }, "a caller answering after the deadline is not taken");
});

test("a whole find's input is read as the call layer reads it: deep JSON reaches the call layer, which refuses it as not sendable; a cycle or a getter that throws is a programming error, nothing sent; an object reached twice and its getters are read once", async (t) => {
	const { client, entry, pagesServed } = await setup(t, { count: 1 });
	let deep = 0;
	for (let i = 0; i < 10_000; i++) deep = [deep];
	let deepObject = {};
	for (let i = 0; i < 10_000; i++) deepObject = { d: deepObject };
	for (const extra of [deep, deepObject]) {
		const before = entry.calls.length;
		const ending = await within(client.find({ kind: "any", extra }, { invocation: ID }));
		const page = await entry.endings[before];
		assert.deepEqual([ending.ending, ending.refusal.part, ending.refusal.code], ["refused", "operation-call", "not-sendable"]);
		assert.deepEqual(ending, { ...page, invocation: ID });
		const single = await within(client.findPage({ kind: "any", extra }, { invocation: ID }));
		assert.deepEqual({ ...ending, attempt: null }, { ...single, attempt: null }, "as a single page is refused");
	}
	assert.equal(pagesServed(), 0, "nothing reached the host");
	const cyclic = { kind: "any" };
	cyclic.self = cyclic;
	const calls = entry.calls.length;
	await assert.rejects(client.find(cyclic), TypeError);
	await assert.rejects(client.find({ get kind() { throw new Error("a getter that throws"); } }), TypeError);
	assert.equal(entry.calls.length, calls, "nothing sent");

	let reads = 0;
	const shared = { get x() { return ++reads; } };
	const { caller, asked } = scriptedCaller([{ position: 0, entries: [], next: null }]);
	await createStoreClient({ caller, host: "host-a", service: "store", bound: 1000, clock: { now: () => 0 } }).find({ kind: "any", a: shared, b: [shared, shared] });
	assert.equal(reads, 1, "the shared object's getter read once");
	assert.deepEqual(asked[0].input, { kind: "any", a: { x: 1 }, b: [{ x: 1 }, { x: 1 }] });
});

test("the abort signal a find is given reaches each of its pages: aborted between pages, the next page is not delivered and the find ends as it did", async (t) => {
	const { client, entry, after } = await setup(t, { count: 5 });
	const signal = new AbortController().signal;
	answerOf(await within(client.find({ kind: "any" }, { signal })));
	assert.equal(entry.calls.length, 3);
	assert.ok(entry.calls.every((p) => p.signal === signal), "every page given the find's signal");
	const controller = new AbortController();
	after[4] = () => controller.abort();
	const ending = await within(client.find({ kind: "any" }, { signal: controller.signal, invocation: ID }));
	const endings = await Promise.all(entry.endings.slice(3));
	assert.equal(endings.length, 2, "no page after the aborted one");
	assert.equal(endings[1].ending, "not-delivered");
	assert.deepEqual(ending, { ...endings[1], invocation: ID, attempt: endings[0].attempt });
});

test("a page whose answer is not a page, first or later, ends the find answered with that page's answer unchanged, under the first page's invocation and attempt", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const opened = await createOperationHost(topology.hostNodes.get("host-a"), { service: "pages" });
	let script = [];
	let served = 0;
	await opened.host.declare({ name: "find", input: { $schema: "urn:apnex:shape-check:dialect:1" }, answers: "whole" }, () => ({ outcome: "answered", answer: script[served++] }));
	await topology.hooks.ready("host-a", "pages/find");
	const entry = topology.caller("alice");
	const client = clientOf(topology, "alice", { service: "pages", bound: 1000 });
	const malformed = [
		{ entries: [{ name: "x" }], next: null },
		{ position: 4, entries: [{ name: "x" }] },
		{ position: 4, entries: [], next: 42 },
		{ position: 4, entries: [], next: false },
		{ position: -1, entries: [], next: null },
		{ position: 4.5, entries: [], next: null },
		{ position: 4, entries: {}, next: null },
		{ position: 4, entries: [], next: "Not a name" },
		[],
		null,
	];
	for (const later of [false, true]) {
		for (const answer of malformed) {
			script = later ? [{ position: 4, entries: [{ name: "a" }], next: "a" }, answer] : [answer];
			served = 0;
			const before = entry.calls.length;
			const ending = await within(client.find({ kind: "any" }, { invocation: ID }));
			const pages = await Promise.all(entry.endings.slice(before));
			assert.equal(pages.length, later ? 2 : 1, JSON.stringify(answer));
			assert.deepEqual(ending, { ending: "answered", invocation: ID, attempt: pages[0].attempt, operation: "find", answer }, `${later ? "a later" : "the first"} page answering ${JSON.stringify(answer)}`);
		}
	}
});
