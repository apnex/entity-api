// changes-since-position (carried from entity-store) - remote reads of changes since a position, once and in
// order (zorg's target, EM16, with EM10's whole find, which the whole changes runs as; Delta 4's D4-E2).
//
// The shared suite's cases for this row run locally and remotely in shared-suite.test.js, and changesPage runs
// through the single-call cases of findPage in find-by-kind-tags.test.js and caller-chosen-bound.test.js. Here,
// with the call bound on a controlled clock: the whole changes over three pages, changes landing between them,
// answered with every item once and in order and the last page's position, each later page asked since the
// previous page's next under a new identity, none marked a repeat, each given the signal; the JSON of its
// ending; each page's bound the time left, rounded down; the bound passing before the first page, between
// pages and while a page waits; a later page refused, not delivered and unknown; the abort signal reaching
// every page; its input and options read once after its clock, the time spent from its bound, and a slow
// getter using the bound up; programming errors thrown whatever the time; an answered page observed at or
// after its deadline losing, a page ending otherwise kept, and a clock that throws as an answer is accepted;
// answers that are not pages, first or later, ended on unchanged, and the boundaries that are pages; and the
// host asking the application's policy before the store, with its whole question, a refusal leaving the store
// unasked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStoreClient } from "@apnex/entity-api";
import { createManualCallClock } from "../support/manual-call-clock.js";
import { openTopology, until, within } from "../support/topology.js";
import { answerOf, clientOf, nodeEvidence, openStore, requested, serve, T0 } from "../support/serving.js";
import { policyRefusal, recordingStore } from "../support/policies.js";

const PAD = 200_000;
const ID = "1791540000000-0123456789abcdef";

/**
 * A store of `count` entities of kind `any`, about 200 KB each, so a page of changes holds two, served on
 * host-a; hooks run before and after the store answers each page of changes, the nth page's by its number.
 */
async function setup(t, { count = 5, historyMs = 60_000, evidence: given = nodeEvidence, bound = 1000, identities } = {}) {
	const topology = await openTopology({ callers: ["alice"], ...(identities ? { identities } : {}) });
	t.after(() => topology.close());
	const opened = openStore({ maxEntityBytes: 262_144, historyMs });
	for (let i = 1; i <= count; i++) opened.store.create({ kind: "any", name: `e${i}`, tags: [], body: { pad: "x".repeat(PAD) } }, { writer: "seed", writeId: `seed-${i}` });
	const before = {};
	const after = {};
	let pages = 0;
	let arrived = 0;
	const evidence = (delivery) => { arrived++; return given(delivery); };
	const store = {
		...Object.fromEntries(["create", "update", "delete", "read", "find", "historyBound", "follow", "waitForChange", "checkRepeat"].map((m) => [m, (...a) => opened.store[m](...a)])),
		changes(input) {
			const n = ++pages;
			before[n]?.(input);
			const page = opened.store.changes(input);
			after[n]?.(page);
			return page;
		},
	};
	await serve(topology, { store, evidence });
	return { topology, entry: topology.caller("alice"), before, after, ...opened, client: clientOf(topology, "alice", { bound }), pagesServed: () => pages, arrived: () => arrived };
}

/** The position of the change an item belongs to: an envelope's `changed`, or a delete's own `position`. */
const positionOf = (item) => ("deleted" in item ? item.position : item.changed.position);

/** The ending of a call whose bound passed with nothing more taken, whole. */
const passed = (invocation, attempt) => ({ ending: "unknown", invocation, attempt, operation: "changes", reason: "bound-passed", agpCode: null, deliveryReport: null });

/** A clock over the topology's call clock that reads `offsets[i]` later at its i-th reading, the last offset holding. */
const steppingClock = (manual, offsets) => {
	let i = 0;
	return { now: () => manual.now() + offsets[Math.min(i++, offsets.length - 1)], schedule: (d, c) => manual.schedule(d, c) };
};

/** A caller answering each page with the given answers in turn; `during[n]` runs as the nth page is answered. */
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
				return Object.freeze({ ending: "answered", invocation, attempt: `${invocation}.0000000${n}`, operation: "changes", answer: answers[n - 1] });
			},
		},
	};
}

const scriptedClient = (caller, clock = { now: () => 0 }) => createStoreClient({ caller, host: "host-a", service: "store", bound: 1000, clock });

test("the whole changes over three pages answers every item once and in order with the last page's position, though changes land between its pages; each later page is asked since the previous page's next, under a new identity, none marked a repeat, each given the signal", async (t) => {
	const { client, entry, store, after } = await setup(t);
	after[1] = () => {
		store.create({ kind: "any", name: "late", tags: [], body: 1 }, { writer: "w", writeId: "c1" });
		store.update({ target: { kind: "any", name: "e1" }, body: { pad: "changed" } }, { writer: "w", writeId: "c2" });
	};
	const signal = new AbortController().signal;
	const ending = await within(client.changes({ since: 0 }, { invocation: ID, signal }));
	const answer = answerOf(ending);
	assert.equal(answer.position, 7, "the last page's position, not the first page's 5");
	assert.deepEqual(answer.changes.map(positionOf), [1, 2, 3, 4, 5, 6, 7], "every item once, in order");
	assert.deepEqual(answer.changes.at(-1).body, { pad: "changed" }, "the update made between pages");
	assert.equal(answer.changes[0].body.pad.length, PAD, "e1 as its create left it");
	const pages = entry.calls;
	assert.deepEqual(pages.map((p) => p.input), [{ since: 0 }, { since: 2 }, { since: 4 }]);
	assert.deepEqual(pages.map((p) => p.operation), ["changes", "changes", "changes"]);
	assert.deepEqual(pages.map((p) => p.invocation), [ID, undefined, undefined], "the first page under the identity given, each later page under a new one");
	const endings = await Promise.all(entry.endings);
	assert.equal(new Set(endings.map((e) => e.invocation)).size, 3);
	assert.deepEqual(endings.map((e) => [e.answer.position, e.answer.next]), [[5, 2], [7, 4], [7, null]], "each page answered the store's position when it answered");
	assert.ok(pages.every((p) => !("repeat" in p)), "no page is marked a repeat");
	assert.ok(pages.every((p) => p.signal === signal), "every page given the signal");
	assert.deepEqual([ending.invocation, ending.attempt, ending.operation], [ID, endings[0].attempt, "changes"], "the identity is its first page's");
	const page = await within(client.changesPage({ since: 5 }));
	assert.deepEqual(answerOf(page), store.changes({ since: 5 }).answer, "changesPage answers exactly as the store answers");
});

test("the JSON of a successful two-page changes", async (t) => {
	const { client, entry, store } = await setup(t, { count: 3 });
	const ending = await within(client.changes({ since: 0 }, { invocation: ID }));
	const first = await entry.endings[0];
	const items = [1, 2, 3].map((i) => store.read({ target: { kind: "any", name: `e${i}` } }).answer.entity);
	assert.equal(entry.calls.length, 2);
	assert.deepEqual(JSON.parse(JSON.stringify(ending)), { ending: "answered", invocation: ID, attempt: first.attempt, operation: "changes", answer: { position: 3, changes: items } });
	assert.deepEqual(Object.keys(ending), ["ending", "invocation", "attempt", "operation", "answer"]);
	assert.deepEqual(Object.keys(ending.answer), ["position", "changes"]);
	assert.ok(Object.isFrozen(ending) && Object.isFrozen(ending.answer) && Object.isFrozen(ending.answer.changes));
});

test("each page is invoked with the time left until the one deadline, rounded down to a whole millisecond", async (t) => {
	const { client, entry, topology, after } = await setup(t);
	after[1] = () => topology.hooks.moveCallClock(100.7);
	after[2] = () => topology.hooks.moveCallClock(250.2);
	answerOf(await within(client.changes({ since: 0 })));
	assert.deepEqual(entry.calls.map((p) => p.bound), [1000, 899, 649]);
});

test("the bound passing before the first page: no page is sent, and changes ends unknown at its bound, attempt null, under the identity given or a new one", async (t) => {
	const { topology, entry } = await setup(t, { count: 1 });
	const identities = { wallTimeMs: () => 1791540000123.9, randomHex: (n) => "a".repeat(n) };
	for (const late of [1000, 1500, 999.5]) {
		const client = () => clientOf(topology, "alice", { bound: 1000, clock: steppingClock(topology.manualClock, [0, late]), identities });
		const given = await within(client().changes({ since: 0 }, { invocation: ID }));
		assert.deepEqual(given, passed(ID, null));
		assert.ok(Object.isFrozen(given));
		const made = await within(client().changes({ since: 0 }));
		assert.deepEqual(made, passed("1791540000123-aaaaaaaaaaaaaaaa", null), "a new identity, as EM11 writes it");
	}
	assert.equal(entry.calls.length, 0, "no page was sent");
	const exactlyOne = clientOf(topology, "alice", { bound: 1000, clock: steppingClock(topology.manualClock, [0, 999]) });
	answerOf(await within(exactlyOne.changes({ since: 0 })));
	assert.deepEqual(entry.calls.map((p) => p.bound), [1], "with exactly 1 millisecond left a page is sent, bounded by it");
});

test("the bound passing between pages: no later page is sent, and changes ends unknown under its first page's identity", async (t) => {
	const { client, entry, topology, after } = await setup(t);
	after[1] = () => topology.hooks.moveCallClock(999.5);
	const ending = await within(client.changes({ since: 0 }, { invocation: ID }));
	const first = await entry.endings[0];
	assert.equal(first.ending, "answered");
	assert.equal(entry.calls.length, 1);
	assert.deepEqual(ending, passed(ID, first.attempt));
});

test("the bound passing while a page waits ends changes as that page ended; the page answering late is discarded, and no further page is sent", async (t) => {
	const held = Promise.withResolvers();
	let requests = 0;
	const evidence = (delivery) => (delivery.destination === "store/changes" && ++requests === 2 ? held.promise : nodeEvidence(delivery));
	const { client, entry, topology, pagesServed } = await setup(t, { evidence });
	const pending = client.changes({ since: 0 }, { invocation: ID });
	await until(() => requests === 2, "the second page reaching the host");
	topology.hooks.advanceCallClock(1000);
	const ending = await within(pending);
	const [first, second] = await Promise.all(entry.endings);
	assert.deepEqual([second.ending, second.reason, second.agpCode], ["unknown", "bound-passed", null]);
	assert.deepEqual(ending, { ...second, invocation: ID, attempt: first.attempt });
	const discarded = entry.caller.discarded();
	held.resolve(nodeEvidence({ source: { originNodeId: "alice" } }));
	await until(() => pagesServed() === 2 && entry.caller.discarded() === discarded + 1, "the late answer to be discarded");
	assert.equal(entry.calls.length, 2, "no page after changes ended");
});

test("a later page ending refused, not delivered or unknown ends changes as that page ended, under the first page's identity", async (t) => {
	await t.test("refused: the position the later page asks since has left the history bound", async (t) => {
		const { client, entry, setTime, after } = await setup(t, { historyMs: 1000 });
		setTime(T0 + 500);
		after[1] = () => setTime(T0 + 2000);
		const ending = await within(client.changes({ since: 0 }, { invocation: ID }));
		const [first, second] = await Promise.all(entry.endings);
		assert.deepEqual([second.refusal.code, second.refusal.details], ["position-not-held", { position: 2 }]);
		assert.deepEqual(ending, { ending: "refused", invocation: ID, attempt: first.attempt, operation: "changes", refusal: second.refusal });
	});
	await t.test("not delivered", async (t) => {
		const { client, entry, after } = await setup(t);
		after[1] = () => entry.failNextSend("NO_ROUTE");
		const ending = await within(client.changes({ since: 0 }, { invocation: ID }));
		const [first, second] = await Promise.all(entry.endings);
		assert.deepEqual([second.ending, second.agpCode], ["not-delivered", "NO_ROUTE"]);
		assert.deepEqual(ending, { ending: "not-delivered", invocation: ID, attempt: first.attempt, operation: "changes", agpCode: "NO_ROUTE", proxyCode: null, earlierAttemptsUncertain: false });
	});
	await t.test("unknown", async (t) => {
		const { client, entry, before } = await setup(t);
		before[2] = () => { throw new Error("the store failed"); };
		const ending = await within(client.changes({ since: 0 }));
		const [first, second] = await Promise.all(entry.endings);
		assert.deepEqual([second.ending, second.reason], ["unknown", "operation-failed"]);
		assert.deepEqual(ending, { ending: "unknown", invocation: first.invocation, attempt: first.attempt, operation: "changes", reason: "operation-failed", agpCode: second.agpCode, deliveryReport: second.deliveryReport });
	});
});

test("the abort signal changes is given reaches each of its pages: aborted between pages, the next page is not delivered and changes ends as it did", async (t) => {
	const { client, entry, after } = await setup(t);
	const controller = new AbortController();
	after[1] = () => controller.abort();
	const ending = await within(client.changes({ since: 0 }, { signal: controller.signal, invocation: ID }));
	const endings = await Promise.all(entry.endings);
	assert.equal(endings.length, 2, "no page after the aborted one");
	assert.equal(endings[1].ending, "not-delivered");
	assert.deepEqual(ending, { ...endings[1], invocation: ID, attempt: endings[0].attempt });
});

test("changes reads its clock as it is called, then its input and options once, into a snapshot: time passing in their getters is spent from its bound", async (t) => {
	const { client, entry, topology } = await setup(t, { count: 3 });
	const reads = { bound: 0, invocation: 0, signal: 0, since: 0 };
	const signal = new AbortController().signal;
	const options = {
		get bound() { reads.bound++; topology.hooks.moveCallClock(100); return 1000; },
		get invocation() { reads.invocation++; topology.hooks.moveCallClock(100); return ID; },
		get signal() { reads.signal++; topology.hooks.moveCallClock(100); return signal; },
	};
	const input = { get since() { reads.since++; topology.hooks.moveCallClock(100.5); return 0; } };
	const ending = await within(client.changes(input, options));
	assert.deepEqual(answerOf(ending).changes.map(positionOf), [1, 2, 3]);
	assert.deepEqual(reads, { bound: 1, invocation: 1, signal: 1, since: 1 }, "each getter read once");
	assert.deepEqual(entry.calls.map((p) => p.bound), [599, 599], "the 400.5 ms spent reading them taken from the one bound, read as changes was called");
	assert.deepEqual(entry.calls.map((p) => [p.input.since, p.signal === signal]), [[0, true], [2, true]]);
	assert.equal(ending.invocation, ID);
});

test("a slow signal, bound or input getter that uses the bound up ends changes unknown at its bound, attempt null, under the identity given or a new one, with no page sent, as changesPage ends for the same input", async (t) => {
	const { topology, entry, pagesServed } = await setup(t, { count: 3 });
	const identities = { wallTimeMs: () => 1791540000123.9, randomHex: (n) => "b".repeat(n) };
	const client = clientOf(topology, "alice", { bound: 10, identities });
	const slow = (ms, value) => { topology.hooks.moveCallClock(ms); return value; };
	const preparations = {
		signal: (ms, given = {}) => [{ since: 0 }, { ...given, get signal() { return slow(ms, undefined); } }],
		bound: (ms, given = {}) => [{ since: 0 }, { ...given, get bound() { return slow(ms, 10); } }],
		input: (ms, given = {}) => [{ get since() { return slow(ms, 0); } }, given],
	};
	for (const [what, prepare] of Object.entries(preparations)) {
		assert.deepEqual(await within(client.changes(...prepare(20, { invocation: ID }))), passed(ID, null), `${what}: under the identity given`);
		assert.deepEqual(await within(client.changes(...prepare(20))), passed("1791540000123-bbbbbbbbbbbbbbbb", null), `${what}: under a new identity`);
		const edge = await within(client.changes(...prepare(9.5)));
		assert.deepEqual([edge.ending, edge.reason, edge.attempt], ["unknown", "bound-passed", null], `${what}: less than 1 ms left`);
	}
	assert.equal(entry.calls.length, 0, "no page was sent");
	const page = await within(client.changesPage(...preparations.input(20)));
	assert.deepEqual([page.ending, page.reason], ["unknown", "bound-passed"], "changesPage ends at its bound for the same input");
	assert.equal(page, await entry.endings[0], "as the call layer, reading its input after its clock, ends it");
	assert.equal(pagesServed(), 0, "nothing sent for changesPage either");
	answerOf(await within(client.changes(...preparations.input(9))));
	assert.deepEqual(entry.calls.slice(1).map((p) => p.bound), [1, 1], "with exactly 1 ms left, each page is sent, bounded by what is left");
});

test("a programming error changes finds, once its bound has passed included, is thrown, and nothing is sent", async (t) => {
	const { topology, entry, arrived } = await setup(t, { count: 1 });
	const client = clientOf(topology, "alice", { bound: 10 });
	const late = () => topology.hooks.moveCallClock(20);
	const cyclic = () => { const value = { since: 0, get extra() { late(); return value; } }; return value; };
	const errors = [
		["a bound not whole", RangeError, () => [{ since: 0 }, { get bound() { late(); return 1.5; } }]],
		["a bound out of range", RangeError, () => [{ since: 0 }, { bound: 0, get signal() { late(); return undefined; } }]],
		["an invocation not as EM11 writes it", TypeError, () => [{ since: 0 }, { get invocation() { late(); return "not-an-identity"; } }]],
		["a signal that is not one", TypeError, () => [{ since: 0 }, { get signal() { late(); return { aborted: "no" }; } }]],
		["options that are not an object", TypeError, () => [{ since: 0 }, 5]],
		["an input that is not a JSON value", TypeError, () => [{ since: 0, get extra() { late(); return () => 1; } }, {}]],
		["an input holding itself", TypeError, () => [cyclic(), {}]],
		["an input whose getter throws", TypeError, () => [{ get since() { late(); throw new Error("a getter that throws"); } }, {}]],
	];
	for (const [what, type, prepare] of errors) await assert.rejects(client.changes(...prepare()), type, what);
	assert.equal(arrived(), 0, "nothing was sent");
	assert.equal(entry.calls.length, 0, "no page handed to the call layer");
});

test("an answered page observed at or after the deadline loses to it, first, final or not a page; a page ending otherwise is kept whenever observed (EM10, step 5); just before the deadline the answer is taken", async () => {
	const refusal = Object.freeze({ part: "entity-store", code: "position-not-held", what: "w", why: "y", fix: "f", details: Object.freeze({ position: 2 }) });
	const others = {
		refused: (address) => ({ ending: "refused", ...address, refusal }),
		"not-delivered": (address) => ({ ending: "not-delivered", ...address, agpCode: "NO_ROUTE", proxyCode: null, earlierAttemptsUncertain: false }),
		unknown: (address) => ({ ending: "unknown", ...address, reason: "operation-failed", agpCode: null, deliveryReport: "delivered" }),
		"answered, a final page": (address) => ({ ending: "answered", ...address, answer: { position: 4, changes: [], next: null } }),
		"answered, not a page": (address) => ({ ending: "answered", ...address, answer: { position: 4, changes: [] } }),
	};
	for (const [what, make] of Object.entries(others)) {
		for (const [page, at] of [[1, 1000], [2, 1000], [2, 1500], [2, 999.5]]) {
			const clock = createManualCallClock(0);
			const asked = [];
			const caller = {
				async invoke(call) {
					asked.push(call);
					const n = asked.length;
					const invocation = call.invocation ?? `179154000000${n}-0123456789abcdef`;
					const address = { invocation, attempt: `${invocation}.0000000${n}`, operation: "changes" };
					if (n < page) return Object.freeze({ ending: "answered", ...address, answer: { position: 4, changes: [{ n: 1 }], next: 2 } });
					clock.move(at - clock.now());
					return Object.freeze(make(address));
				},
			};
			const ending = await scriptedClient(caller, clock).changes({ since: 0 }, { invocation: ID });
			const label = `page ${page} ending ${what}, observed ${at} ms after changes began`;
			assert.equal(asked.length, page, label);
			const first = { invocation: ID, attempt: `${ID}.00000001` };
			const shown = make({ invocation: "", attempt: "", operation: "changes" });
			if (shown.ending !== "answered") assert.deepEqual(ending, { ...shown, ...first }, `${label}: ended as the page ended`);
			else if (at >= 1000) assert.deepEqual(ending, passed(ID, first.attempt), `${label}: the deadline wins`);
			else if (what === "answered, a final page") assert.deepEqual(answerOf(ending), { position: 4, changes: page === 2 ? [{ n: 1 }] : [] }, `${label}: taken`);
			else assert.deepEqual(ending, { ...shown, ...first }, `${label}: not a page, its answer unchanged`);
			assert.ok(Object.isFrozen(ending), label);
		}
	}
});

test("a reading of entity-api's clock that throws as a page's answer is accepted cannot show the deadline passed, so the answer observed decides; one that throws before a later page is sent is thrown", async () => {
	/** A clock reading 0 but for the readings after page `page` answered: the first `faults` of them throw. */
	const faulting = (page, faults) => {
		let throwing = 0;
		let answered = 0;
		const counts = { faults: 0 };
		const clock = { now() { if (throwing > 0) { throwing--; counts.faults++; throw new Error("reading once a page has answered"); } return 0; } };
		const pages = [{ position: 4, changes: [{ n: 1 }], next: 2 }, { position: 5, changes: [{ n: 2 }], next: null }];
		const { caller, asked } = scriptedCaller(pages);
		const wrapped = { async invoke(call) { const ending = await caller.invoke(call); if (++answered === page) throwing = faults; return ending; } };
		return { client: scriptedClient(wrapped, clock), counts, asked };
	};
	for (const page of [1, 2]) {
		const { client, counts, asked } = faulting(page, 1);
		const ending = await client.changes({ since: 0 }, { invocation: ID });
		assert.equal(counts.faults, 1, `page ${page}: the acceptance reading threw`);
		assert.equal(asked.length, 2, `page ${page}: both pages asked`);
		assert.deepEqual(answerOf(ending), { position: 5, changes: [{ n: 1 }, { n: 2 }] }, `page ${page}: the answers observed decide`);
		assert.deepEqual([ending.invocation, ending.attempt], [ID, `${ID}.00000001`]);
	}
	const { client, counts, asked } = faulting(1, 2);
	await assert.rejects(client.changes({ since: 0 }, { invocation: ID }), /reading once a page has answered/);
	assert.equal(counts.faults, 2, "the acceptance reading and the later page's reading both threw");
	assert.equal(asked.length, 1, "no later page was sent");
});

test("an answer that is not a page, first or later, ends changes answered with that answer unchanged under the first page's identity, no further page asked; the boundaries that are pages are taken", async () => {
	// Asked first since 0; a later page is asked since 2, after a first page whose next is 2.
	const notPages = [
		{ changes: [], next: null },
		{ position: 4, next: null },
		{ position: 4, changes: [] },
		{ position: -1, changes: [], next: null },
		{ position: 4.5, changes: [], next: null },
		{ position: "4", changes: [], next: null },
		{ position: 4, changes: {}, next: null },
		{ position: 4, changes: [], next: 3.5 },
		{ position: 4, changes: [], next: "3" },
		{ position: 4, changes: [], next: false },
		{ position: 4, changes: [], next: 0 },
		{ position: 4, changes: [], next: 5 },
		[],
		null,
		"page",
	];
	const notAboveLaterSince = [{ position: 4, changes: [], next: 2 }, { position: 4, changes: [], next: 1 }];
	const firstPage = { position: 4, changes: [{ n: 1 }], next: 2 };
	for (const later of [false, true]) {
		for (const answer of [...notPages, ...(later ? notAboveLaterSince : [])]) {
			const { caller, asked } = scriptedCaller(later ? [firstPage, answer] : [answer]);
			const ending = await scriptedClient(caller).changes({ since: 0 }, { invocation: ID });
			const label = `${later ? "a later" : "the first"} page answering ${JSON.stringify(answer)}`;
			assert.equal(asked.length, later ? 2 : 1, `${label}: no further page`);
			assert.deepEqual(ending, { ending: "answered", invocation: ID, attempt: `${ID}.00000001`, operation: "changes", answer }, label);
		}
	}
	const boundaries = [
		["next one above since, and the page's position", [{ position: 1, changes: [{ n: 1 }], next: 1 }, { position: 2, changes: [{ n: 2 }], next: 2 }, { position: 2, changes: [], next: null }], [{ since: 0 }, { since: 1 }, { since: 2 }], 2],
		["next null on a page of no items at position 0", [{ position: 0, changes: [], next: null }], [{ since: 0 }], 0],
	];
	for (const [what, answers, inputs, position] of boundaries) {
		const { caller, asked } = scriptedCaller(answers);
		const ending = await scriptedClient(caller).changes({ since: 0 });
		assert.deepEqual(asked.map((c) => c.input), inputs, `${what}: each later page since the previous next`);
		assert.equal(answerOf(ending).position, position, what);
	}
});

test("the host asks the application's policy before the store for changes, with the input, the evidence and the delivery context as given, writer null, target null and repeat false, and never names a writer; a refusal is answered unchanged and the store is not asked", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const opened = openStore({ historyMs: 1000 });
	opened.store.create({ kind: "any", name: "a", tags: [], body: 0 }, { writer: "seed", writeId: "s1" });
	opened.setTime(T0 + 500);
	const log = [];
	const questions = [];
	let refuse = false;
	await serve(topology, {
		store: recordingStore(opened.store, log),
		nameWriter: (caller) => { log.push("writer"); return caller.evidence.node; },
		policy: (question) => { log.push("policy"); questions.push(question); return refuse ? { allowed: false, refusal: policyRefusal("not-writer", { writer: "nobody" }) } : { allowed: true }; },
	});
	const client = clientOf(topology, "alice");
	const page = answerOf(await within(client.changesPage({ since: 0 })));
	assert.equal(page.changes.length, 1);
	assert.deepEqual(log, ["policy", "changes"], "the policy first, then the store; no writer named");
	const [question] = questions;
	assert.deepEqual(Object.keys(question).sort(), ["delivery", "evidence", "input", "operation", "repeat", "target", "writer"]);
	assert.deepEqual([question.operation, question.input, question.evidence, question.writer, question.target, question.repeat], ["changes", { since: 0 }, { kind: "test-node", node: "alice" }, null, null, false]);
	assert.equal(question.delivery.source.originNodeId, "alice");
	assert.ok(Object.isFrozen(question) && Object.isFrozen(question.input) && Object.isFrozen(question.evidence), "the question, its input and its evidence are frozen");
	refuse = true;
	log.length = 0;
	const records = opened.storage.records().length;
	opened.setTime(T0 + 900);
	const refused = await within(client.changes({ since: 0 }, { invocation: ID }));
	assert.deepEqual([refused.ending, refused.refusal], ["refused", policyRefusal("not-writer", { writer: "nobody" })], "the policy's refusal, unchanged");
	assert.deepEqual(log, ["policy"], "the store not asked");
	assert.equal(opened.storage.records().length, records, "nothing appended, not even a time record");
	assert.deepEqual(requested(topology.caller("alice").calls.at(-1)).input, { since: 0 });
});
