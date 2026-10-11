// stated-history-bound (carried from entity-store) - a remote reader can read the store's history bound, and
// a reader behind it is told so (zorg's target, EM8, EM10; fence item 4; E4).
//
// Cases: a remote reader reads the bound the store was opened with, with the store's position, and reads the
// same bound from a store reopened on the same storage; a remote find as of a position whose following change
// is outside the bound is refused as position-not-held, a page or a whole find, while the store's own
// position is always held; and the bound read remotely is the one a write's repeat is decided by.
import assert from "node:assert/strict";
import { test } from "node:test";
import { within } from "../support/topology.js";
import { answerOf, clientOf, note, openStore, serve, served, T0 } from "../support/serving.js";

test("a remote reader reads the bound the store was opened with, with the store's position, and the same after the store is reopened", async (t) => {
	const { clients: { alice, bob }, storage, server, topology } = await served(t, { store: { historyMs: 86_400_000 } });
	assert.deepEqual(answerOf(await within(bob.historyBound())), { position: 0, historyMs: 86_400_000 });
	answerOf(await within(alice.create(note("alpha"))));
	assert.deepEqual(answerOf(await within(bob.historyBound())), { position: 1, historyMs: 86_400_000 });
	await server.close();
	for (const op of ["create", "update", "delete", "read", "find", "history-bound", "describe"]) await topology.hooks.gone("host-a", `store/${op}`);
	const reopened = openStore({ historyMs: 86_400_000, storage });
	await serve(topology, { store: reopened.store });
	assert.deepEqual(answerOf(await within(clientOf(topology, "bob").historyBound())), { position: 1, historyMs: 86_400_000 });
});

test("a remote reader behind the bound is told so: a find as of a position whose following change is outside it is refused as position-not-held", async (t) => {
	const { clients: { alice, bob }, setTime } = await served(t, { store: { historyMs: 1000 } });
	answerOf(await within(alice.create(note("alpha"))));
	setTime(T0 + 500);
	answerOf(await within(alice.create(note("beta"))));
	setTime(T0 + 999);
	assert.deepEqual(answerOf(await within(bob.find({ kind: "note", asOf: 0 }))), { position: 0, entries: [] }, "one millisecond inside the bound");
	setTime(T0 + 1000);
	for (const ending of [await within(bob.findPage({ kind: "note", asOf: 0 })), await within(bob.find({ kind: "note", asOf: 0 }))]) {
		assert.equal(ending.ending, "refused");
		assert.deepEqual([ending.refusal.part, ending.refusal.code, ending.refusal.details], ["entity-store", "position-not-held", { position: 0 }]);
	}
	assert.equal(answerOf(await within(bob.find({ kind: "note", asOf: 1 }))).entries.length, 1, "as of 1 is held: the change after it is within the bound");
	setTime(T0 + 10 * 86_400_000);
	assert.equal(answerOf(await within(bob.find({ kind: "note", asOf: 2 }))).position, 2, "the store's own position is always held");
});

test("the bound read remotely is the one a remote write's repeat is decided by", async (t) => {
	const { clients: { alice }, setTime } = await served(t, { callers: ["alice"], store: { historyMs: 2500 } });
	const { historyMs } = answerOf(await within(alice.historyBound()));
	const first = await within(alice.create({ kind: "any", name: "n", tags: [], body: 0 }));
	setTime(T0 + historyMs - 1);
	assert.equal(answerOf(await within(alice.create({ kind: "any", name: "n", tags: [], body: 0 }, { invocation: first.invocation, repeat: true }))).position, 1, "recognised just inside the bound read");
	setTime(T0 + historyMs);
	assert.equal((await within(alice.create({ kind: "any", name: "n", tags: [], body: 0 }, { invocation: first.invocation, repeat: true }))).refusal.code, "name-taken", "run afresh at it");
});
