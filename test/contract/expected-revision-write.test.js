// expected-revision-write (carried from entity-store) - an expected revision crosses the network, and a
// conflict returns as a refusal with its reason (zorg's target, EM6, EM9).
//
// Cases: of two remote callers who read the same revision, the first to write is applied and the second is
// refused as revision-moved, naming both revisions, unchanged from the store and taking no position; a delete
// naming another revision is refused and one naming the current revision applied; a write naming no expected
// revision is applied whatever the current revision; and a write naming one of an entity that does not exist
// is refused as not-found first.
import assert from "node:assert/strict";
import { test } from "node:test";
import { within } from "../support/topology.js";
import { answerOf, note, openStore, served } from "../support/serving.js";

test("of two remote callers who read the same revision, the second to write is refused as revision-moved, naming both, unchanged from the store", async (t) => {
	const { clients: { alice, bob }, store } = await served(t);
	answerOf(await within(alice.create(note("alpha"))));
	const seenByAlice = answerOf(await within(alice.read({ target: { id: "e1.1" } }))).entity.revision;
	const seenByBob = answerOf(await within(bob.read({ target: { id: "e1.1" } }))).entity.revision;
	answerOf(await within(alice.update({ target: { id: "e1.1" }, expectedRevision: seenByAlice, body: { summary: "alice" } })));
	const refused = await within(bob.update({ target: { id: "e1.1" }, expectedRevision: seenByBob, body: { summary: "bob" } }));
	const local = openStore();
	local.store.create(note("alpha"), { writer: "w", writeId: "1" });
	local.store.update({ target: { id: "e1.1" }, body: { summary: "x" } }, { writer: "w", writeId: "2" });
	const expected = local.store.update({ target: { id: "e1.1" }, expectedRevision: 1, body: { summary: "bob" } }, { writer: "w", writeId: "3" }).refusal;
	assert.equal(refused.ending, "refused");
	assert.deepEqual(refused.refusal, expected);
	assert.deepEqual([refused.refusal.code, refused.refusal.details], ["revision-moved", { expected: 1, current: 2 }]);
	assert.equal(store.historyBound().answer.position, 2, "the refusal took no position");
	assert.equal(store.read({ target: { id: "e1.1" } }).answer.entity.body.summary, "alice");
});

test("a delete naming another revision is refused, and one naming the current revision is applied", async (t) => {
	const { clients: { alice } } = await served(t, { callers: ["alice"] });
	answerOf(await within(alice.create(note("alpha"))));
	const stale = await within(alice.delete({ target: { kind: "note", name: "alpha" }, expectedRevision: 2 }));
	assert.deepEqual([stale.refusal.code, stale.refusal.details], ["revision-moved", { expected: 2, current: 1 }]);
	assert.deepEqual(answerOf(await within(alice.delete({ target: { kind: "note", name: "alpha" }, expectedRevision: 1 }))).deleted, { id: "e1.1", kind: "note", name: "alpha", revision: 2 });
});

test("a write naming no expected revision is applied whatever the current revision; one naming a revision of nothing is refused as not-found", async (t) => {
	const { clients: { alice, bob } } = await served(t);
	answerOf(await within(alice.create(note("alpha"))));
	for (let i = 0; i < 3; i++) answerOf(await within(alice.update({ target: { id: "e1.1" }, tags: [`n:${i}`] })));
	assert.equal(answerOf(await within(bob.update({ target: { id: "e1.1" }, body: { summary: "blind" } }))).entity.revision, 5);
	const missing = await within(bob.update({ target: { id: "e7.1" }, expectedRevision: 1, name: "x" }));
	assert.deepEqual([missing.refusal.code, missing.refusal.details], ["not-found", { target: { id: "e7.1" } }]);
});
