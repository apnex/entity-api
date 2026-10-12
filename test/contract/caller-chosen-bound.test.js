// caller-chosen-bound (carried from operation-call) - a remote caller sets each operation's bound: total time
// for a whole answer (zorg's target, EM10, EM12; E15).
//
// Cases, with the call bound on a controlled clock and every answer withheld: each operation the client offers
// ends unknown exactly at the bound its caller gave - the call's own or the client's - and not a millisecond
// before; the whole find's bound is one deadline for all its pages, from the moment it is called, however its
// pages spend it; and a bound outside 1 to 2147483647 milliseconds, or not whole, is a programming error,
// thrown with nothing sent. With operation-call's default clock, a whole find's deadline is read only once its
// input and options are read, and no page is answered after it: time passing in their getters, in the first
// and a later page's preparation, and a final page that cannot be accepted, each with wide margins.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStoreClient } from "@apnex/entity-api";
import { openTopology, preparingIdentities, turn, until, within } from "../support/topology.js";
import { answerOf, clientOf, nodeEvidence, openStore, serve } from "../support/serving.js";

/** A store served with its requests held at the evidence port until released, so no answer comes. */
async function withheld(t) {
	const topology = await openTopology({ callers: ["alice"] });
	const releases = [];
	t.after(() => { for (const r of releases) r(); return topology.close(); });
	const { store } = openStore({ maxEntityBytes: 262_144 });
	let hold = true;
	let arrived = 0;
	await serve(topology, { store, evidence: (delivery) => {
		arrived++;
		if (!hold) return nodeEvidence(delivery);
		return new Promise((resolve) => releases.push(() => resolve(nodeEvidence(delivery))));
	} });
	return { topology, store, entry: topology.caller("alice"), arrived: () => arrived, setHold: (h) => { hold = h; } };
}

test("each operation ends unknown exactly at the bound its caller gave, the call's own or the client's, and not before", async (t) => {
	const { topology, arrived } = await withheld(t);
	const client = clientOf(topology, "alice", { bound: 300 });
	const calls = [
		[() => client.create({ kind: "any", name: "n", tags: [], body: 0 }, { bound: 250 }), 250],
		[() => client.update({ target: { id: "e1.1" }, body: 1 }), 300],
		[() => client.delete({ target: { id: "e1.1" } }, { bound: 1 }), 1],
		[() => client.read({ target: { id: "e1.1" } }, { bound: 777 }), 777],
		[() => client.findPage({ kind: "any" }), 300],
		[() => client.find({ kind: "any" }, { bound: 120 }), 120],
		[() => client.historyBound({ bound: 2 }), 2],
	];
	for (const [i, [call, bound]] of calls.entries()) {
		let ending;
		const pending = call().then((e) => { ending = e; });
		await until(() => arrived() === i + 1, "the request to reach the host");
		if (bound > 1) topology.hooks.advanceCallClock(bound - 1);
		for (let k = 0; k < 5; k++) await turn();
		assert.equal(ending, undefined, `no ending a millisecond before ${bound}`);
		topology.hooks.advanceCallClock(1);
		await within(pending);
		assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"], `ended at ${bound}`);
	}
});

test("a whole find's bound is one deadline for all its pages, from the moment it is called", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	const held = Promise.withResolvers();
	t.after(() => { held.resolve(); return topology.close(); });
	const opened = openStore({ maxEntityBytes: 262_144 });
	for (let i = 1; i <= 5; i++) opened.store.create({ kind: "any", name: `e${i}`, tags: [], body: { pad: "x".repeat(200_000) } }, { writer: "w", writeId: `${i}` });
	let pages = 0;
	let requests = 0;
	const store = { checkRepeat: (...a) => opened.store.checkRepeat(...a), read: (...a) => opened.store.read(...a), historyBound: () => opened.store.historyBound(), create: (...a) => opened.store.create(...a), update: (...a) => opened.store.update(...a), delete: (...a) => opened.store.delete(...a),
		find(input) {
			const page = opened.store.find(input);
			// The first page's answer leaves 600 ms; the second's 249.5.
			topology.hooks.moveCallClock(++pages === 1 ? 400 : 350.5);
			return page;
		} };
	await serve(topology, { store, evidence: (delivery) => (delivery.destination === "store/find" && ++requests === 3 ? held.promise.then(() => nodeEvidence(delivery)) : nodeEvidence(delivery)) });
	const entry = topology.caller("alice");
	const pending = clientOf(topology, "alice", { bound: 1000 }).find({ kind: "any" });
	await until(() => requests === 3, "the third page, held at the host");
	assert.deepEqual(entry.calls.map((c) => c.bound), [1000, 600, 249], "each page given only what is left of the one bound, rounded down");
	topology.hooks.advanceCallClock(249);
	const ending = await within(pending);
	assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"], "the find ends at its one deadline, 1000 ms after it was called");
	assert.equal(ending.invocation, (await entry.endings[0]).invocation);
});

test("a bound outside 1 to 2147483647 milliseconds, or not whole, is a programming error, thrown with nothing sent", async (t) => {
	const { topology, store } = await withheld(t);
	const client = clientOf(topology, "alice");
	for (const bound of [0, -1, 2147483648, 1.5, Number.NaN, "10"]) {
		await assert.rejects(client.read({ target: { id: "e1.1" } }, { bound }), RangeError, `read, ${bound}`);
		await assert.rejects(client.create({ kind: "any", name: "n", tags: [], body: 0 }, { bound }), RangeError, `create, ${bound}`);
		await assert.rejects(client.find({ kind: "any" }, { bound }), RangeError, `find, ${bound}`);
	}
	assert.equal(store.historyBound().answer.position, 0);
});

/** Spends real time synchronously, as a slow getter or port of the caller's would. */
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };

/** A topology on operation-call's default clock, with three entities of about 200 KB served, so a find takes two pages. */
async function realClock(t, { identities, find } = {}) {
	const topology = await openTopology({ callers: ["alice"], realCallClock: true, ...(identities ? { identities } : {}) });
	t.after(() => topology.close());
	const opened = openStore({ maxEntityBytes: 262_144 });
	for (let i = 1; i <= 3; i++) opened.store.create({ kind: "any", name: `e${i}`, tags: [], body: { pad: "x".repeat(200_000) } }, { writer: "w", writeId: `${i}` });
	let pages = 0;
	const store = { ...Object.fromEntries(["create", "update", "delete", "read", "historyBound", "checkRepeat"].map((m) => [m, (...a) => opened.store[m](...a)])),
		find(input) { const n = ++pages; const page = opened.store.find(input); find?.(n); return page; } };
	await serve(topology, { store });
	return { topology, entry: topology.caller("alice"), pages: () => pages };
}

test("on the default clock, time spent in a find's option and input getters is spent before its deadline is read, so its first page is given the whole bound", async (t) => {
	const { topology, entry } = await realClock(t);
	const client = clientOf(topology, "alice", { bound: 60_000, clock: topology.callClock });
	const options = { get bound() { busy(150); return 60_000; }, get signal() { busy(150); return undefined; } };
	const input = { get kind() { busy(150); return "any"; } };
	answerOf(await within(client.find(input, options)));
	assert.ok(entry.calls[0].bound >= 59_999, `the first page's bound, ${entry.calls[0].bound}, takes nothing for the 450 ms spent in getters`);
});

test("on the default clock, a first or later page whose preparation outlasts the find's bound is never answered: the find ends unknown at its bound", async (t) => {
	for (const page of [1, 2]) {
		const { source, hooks } = preparingIdentities();
		const { topology, entry, pages } = await realClock(t, { identities: source });
		hooks.attempt = (n) => { if (n === page) busy(1500); };
		const ending = await within(clientOf(topology, "alice", { bound: 1000, clock: topology.callClock }).find({ kind: "any" }));
		assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"], `preparing page ${page}`);
		assert.ok(pages() < page, `page ${page} was never served`);
		assert.ok(entry.calls.length <= page, "no page after it");
	}
});

test("on the default clock, a final page that cannot be accepted, answering after the find's deadline, ends the find unknown at its bound, not answered", async (t) => {
	const { topology } = await realClock(t, { find: (n) => { if (n === 2) busy(1500); } });
	const ending = await within(clientOf(topology, "alice", { bound: 1000, clock: topology.callClock }).find({ kind: "any" }));
	assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"], "the final page answered after the deadline is not taken");
	let pages = 0;
	const caller = { async invoke(call) {
		pages++;
		if (pages === 2) busy(call.bound + 300);
		return { ending: "answered", invocation: "1791540000000-0123456789abcdef", attempt: "1791540000000-0123456789abcdef.0000000" + pages, operation: "find", answer: { position: 3, entries: [], next: pages === 1 ? "a" : null } };
	} };
	const late = await createStoreClient({ caller, host: "host-a", service: "store", bound: 1000, clock: topology.callClock }).find({ kind: "any" });
	assert.deepEqual([late.ending, late.reason, late.attempt], ["unknown", "bound-passed", "1791540000000-0123456789abcdef.00000001"], "a caller answering after the deadline is not taken");
});
