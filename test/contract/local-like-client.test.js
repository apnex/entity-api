// local-like-client - a client half offers the store's operations to application logic as if the store were
// local (zorg's target, EM7, EM10, EM12; E11's fidelity).
//
// Cases: the same operations answer exactly as the same store called directly - each change, read, page and
// bound, and a whole find answering every match as a page of the local store does; each operation is one
// invocation of the caller it is given, of the operation of that name, pinned to the host named, under the
// name the store is served by, with the input unchanged - no writer and no write identity added - the bound
// the call or the client names, and a write's invocation and repeat flag; the ending is the call layer's,
// unchanged; each write's identity is its invocation identity, in the store's change log; any object offering
// the caller's interface serves, as operation-proxy's client half does; and the client's programming errors
// are thrown with nothing sent, each found by the client itself, as it reads the call (EM10), before the call
// layer is reached.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStoreClient } from "@apnex/entity-api";
import { openTopology, within } from "../support/topology.js";
import { answerOf, clientOf, note, openStore, serve, T0 } from "../support/serving.js";

async function setup(t) {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const remote = openStore();
	await serve(topology, { store: remote.store });
	return { topology, remote, entry: topology.caller("alice"), client: clientOf(topology, "alice") };
}

test("the client's operations answer exactly as the same store called directly, change by change", async (t) => {
	const { remote, client } = await setup(t);
	const local = openStore();
	const write = (n) => ({ writer: "alice", writeId: `w${n}` });
	const steps = [
		[(c) => c.create(note("alpha", ["t:x"])), (s) => s.create(note("alpha", ["t:x"]), write(1))],
		[(c) => c.create({ kind: "any", name: "list", tags: [], body: [1, "two", { three: null }] }), (s) => s.create({ kind: "any", name: "list", tags: [], body: [1, "two", { three: null }] }, write(2))],
		[(c) => c.update({ target: { kind: "note", name: "alpha" }, expectedRevision: 1, name: "beta", tags: ["t:y"] }), (s) => s.update({ target: { kind: "note", name: "alpha" }, expectedRevision: 1, name: "beta", tags: ["t:y"] }, write(3))],
		[(c) => c.read({ target: { id: "e1.1" } }), (s) => s.read({ target: { id: "e1.1" } })],
		[(c) => c.read({ target: { kind: "note", name: "alpha" } }), (s) => s.read({ target: { kind: "note", name: "alpha" } })],
		[(c) => c.findPage({ kind: "note", tags: ["t:y"] }), (s) => s.find({ kind: "note", tags: ["t:y"] })],
		[(c) => c.findPage({ kind: "any", asOf: 2 }), (s) => s.find({ kind: "any", asOf: 2 })],
		[(c) => c.historyBound(), (s) => s.historyBound()],
		[(c) => c.delete({ target: { id: "e2.1" }, expectedRevision: 1 }), (s) => s.delete({ target: { id: "e2.1" }, expectedRevision: 1 }, write(4))],
		[(c) => c.update({ target: { id: "e1.1" }, expectedRevision: 1, body: { summary: "x" } }), (s) => s.update({ target: { id: "e1.1" }, expectedRevision: 1, body: { summary: "x" } }, write(5))],
		[(c) => c.read({ target: { id: "e2.1" } }), (s) => s.read({ target: { id: "e2.1" } })],
	];
	for (const [i, [remotely, locally]] of steps.entries()) {
		remote.setTime(T0 + i * 1000);
		local.setTime(T0 + i * 1000);
		const ending = await within(remotely(client));
		const outcome = locally(local.store);
		if (outcome.outcome === "answered") assert.deepEqual(answerOf(ending, `step ${i}`), outcome.answer, `step ${i}: the same answer`);
		else assert.deepEqual([ending.ending, ending.refusal], ["refused", outcome.refusal], `step ${i}: the same refusal`);
	}
	const page = local.store.find({ kind: "note" }).answer;
	assert.deepEqual(answerOf(await within(client.find({ kind: "note" }))), { position: page.position, entries: page.entries }, "a whole find answers every match, as one page of this store does");
});

test("each operation is one invocation of the operation of its name, pinned to the host named, under the store's name, with the input unchanged and the bound the call or the client names", async (t) => {
	const { entry, client } = await setup(t);
	const signal = new AbortController().signal;
	const calls = [
		[() => client.create(note("alpha"), { bound: 1234, signal }), "create", note("alpha"), 1234],
		[() => client.update({ target: { id: "e1.1" }, name: "beta" }), "update", { target: { id: "e1.1" }, name: "beta" }, 10_000],
		[() => client.read({ target: { id: "e1.1" } }, { bound: 7 }), "read", { target: { id: "e1.1" } }, 7],
		[() => client.findPage({ kind: "note", after: "a" }), "find", { kind: "note", after: "a" }, 10_000],
		[() => client.historyBound({ bound: 99 }), "history-bound", {}, 99],
		[() => client.delete({ target: { id: "e1.1" } }), "delete", { target: { id: "e1.1" } }, 10_000],
	];
	for (const [call, operation, input, bound] of calls) {
		const before = entry.calls.length;
		await within(call());
		assert.equal(entry.calls.length, before + 1, `${operation} is one invocation`);
		const made = entry.calls.at(-1);
		assert.deepEqual({ ...made, signal: undefined }, { host: "host-a", service: "store", operation, input, bound, signal: undefined });
	}
	assert.equal(entry.calls[0].signal, signal, "the signal is the caller's own");
	for (const made of entry.calls) {
		assert.equal(JSON.stringify(made.input).includes("writer"), false, "no writer added");
		assert.equal(JSON.stringify(made.input).includes("writeId"), false, "no write identity added");
	}
});

test("a write's invocation identity and repeat flag reach the call layer; a read's invocation does, and no repeat flag", async (t) => {
	const { entry, client } = await setup(t);
	const id = entry.caller.newInvocation();
	await within(client.create(note("alpha"), { invocation: id, repeat: true }));
	assert.deepEqual([entry.calls.at(-1).invocation, entry.calls.at(-1).repeat], [id, true]);
	await within(client.update({ target: { id: "e1.1" }, name: "b" }, { repeat: false }));
	assert.deepEqual([entry.calls.at(-1).invocation, entry.calls.at(-1).repeat], [undefined, false]);
	const readId = entry.caller.newInvocation();
	await within(client.read({ target: { id: "e1.1" } }, { invocation: readId, repeat: true }));
	assert.deepEqual([entry.calls.at(-1).invocation, "repeat" in entry.calls.at(-1)], [readId, false]);
});

test("the ending is the call layer's, unchanged: frozen, with EM12's fields, its identity the one each write is recorded under in the change log", async (t) => {
	const { client, remote } = await setup(t);
	const endings = [];
	endings.push(await within(client.create(note("alpha"))));
	endings.push(await within(client.update({ target: { id: "e1.1" }, name: "beta" })));
	endings.push(await within(client.delete({ target: { id: "e1.1" } })));
	for (const e of endings) {
		assert.ok(Object.isFrozen(e));
		assert.deepEqual(Object.keys(e).sort(), ["answer", "attempt", "ending", "invocation", "operation"]);
		assert.match(e.invocation, /^[0-9]{13}-[0-9a-f]{16}$/);
		assert.ok(e.attempt.startsWith(`${e.invocation}.`));
	}
	const records = remote.storage.records().filter((r) => r.type === "change");
	assert.deepEqual(records.map((r) => r.writeId), endings.map((e) => e.invocation), "each write's identity is its invocation identity");
	const refused = await within(client.read({ target: { kind: "nope", name: "x" } }));
	assert.deepEqual(Object.keys(refused).sort(), ["attempt", "ending", "invocation", "operation", "refusal"]);
});

test("any object offering the caller's interface serves the client, as operation-proxy's client half does", async (t) => {
	const { entry } = await setup(t);
	const client = createStoreClient({ caller: { invoke: (call) => entry.caller.invoke(call) }, host: "host-a", service: "store", bound: 5000 });
	assert.equal(answerOf(await within(client.create(note("alpha")))).position, 1);
	assert.equal(answerOf(await within(client.find({ kind: "note" }))).entries.length, 1);
});

test("the client's programming errors are thrown, and nothing is sent", async (t) => {
	const { entry, topology } = await setup(t);
	const caller = entry.caller;
	assert.throws(() => createStoreClient(), TypeError);
	assert.throws(() => createStoreClient({ caller: {}, host: "host-a", service: "store" }), TypeError);
	assert.throws(() => createStoreClient({ caller, host: "", service: "store" }), TypeError);
	assert.throws(() => createStoreClient({ caller, host: "host-a", service: "Store" }), TypeError);
	assert.throws(() => createStoreClient({ caller, host: "host-a", service: "store", bound: 0 }), RangeError);
	assert.throws(() => createStoreClient({ caller, host: "host-a", service: "store", clock: {} }), TypeError);
	const unbounded = createStoreClient({ caller, host: "host-a", service: "store", clock: topology.callClock });
	const before = entry.calls.length;
	await assert.rejects(unbounded.create(note("alpha")), RangeError, "a call with no bound, given or by default");
	await assert.rejects(unbounded.find({ kind: "note" }), RangeError);
	const client = clientOf(topology, "alice");
	await assert.rejects(client.read({ target: { id: "e1.1" } }, { bound: 2147483648 }), RangeError);
	await assert.rejects(client.find({ kind: "note" }, { bound: 1.5 }), RangeError);
	await assert.rejects(client.create(note("alpha"), { invocation: "not-an-identity" }), TypeError);
	await assert.rejects(client.find({ kind: "note" }, { invocation: "not-an-identity" }), TypeError);
	await assert.rejects(client.find({ kind: "note", tags: [() => 1] }), TypeError);
	await assert.rejects(client.read({ target: {} }, "fast"), TypeError);
	await assert.rejects(client.read({ target: [() => 1] }), TypeError);
	await assert.rejects(client.update({ target: { id: "e1.1" } }, { repeat: "yes" }), TypeError);
	assert.equal(entry.calls.length - before, 0, "the client checks every call's arguments itself, as it reads them, so none reached the call layer");
	assert.equal(answerOf(await within(client.historyBound())).position, 0, "nothing was sent");
});
