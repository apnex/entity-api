// identity-name-lookup (carried from entity-store) - remote reads by identity or name, each with the store's
// position (zorg's target, EM1, EM3, EM6, EM10; E1, E2).
//
// Cases: a remote read by identity and one by kind and name return the same entity whole, each with the
// store's position; a read naming nothing answers null with the position; a rename moves the name while the
// identity stays; a deleted entity's name reads as the entity that takes it next; a target that is neither an
// identity nor a kind and a name, and a kind the store was not given, are refused unchanged from the store.
import assert from "node:assert/strict";
import { test } from "node:test";
import { within } from "../support/topology.js";
import { answerOf, note, served } from "../support/serving.js";

test("a remote read by identity and by kind and name return the same entity whole, each with the store's position", async (t) => {
	const { clients: { alice, bob }, store } = await served(t);
	answerOf(await within(alice.create(note("alpha"))));
	answerOf(await within(alice.create(note("beta"))));
	const byId = answerOf(await within(bob.read({ target: { id: "e1.1" } })));
	const byName = answerOf(await within(bob.read({ target: { kind: "note", name: "alpha" } })));
	assert.deepEqual(byId, byName);
	assert.deepEqual(byId, store.read({ target: { id: "e1.1" } }).answer);
	assert.equal(byId.position, 2, "the store's position, not the entity's");
	assert.deepEqual(answerOf(await within(bob.read({ target: { kind: "note", name: "nobody" } }))), { position: 2, entity: null });
	assert.deepEqual(answerOf(await within(bob.read({ target: { id: "e9.1" } }))), { position: 2, entity: null });
	assert.deepEqual(answerOf(await within(bob.read({ target: { kind: "any", name: "alpha" } }))), { position: 2, entity: null }, "a name held only in another kind");
});

test("a rename moves the name and keeps the identity; a deleted entity's name reads as the entity that takes it next", async (t) => {
	const { clients: { alice, bob } } = await served(t);
	answerOf(await within(alice.create(note("alpha"))));
	answerOf(await within(alice.update({ target: { id: "e1.1" }, name: "omega" })));
	assert.equal(answerOf(await within(bob.read({ target: { kind: "note", name: "alpha" } }))).entity, null);
	assert.equal(answerOf(await within(bob.read({ target: { kind: "note", name: "omega" } }))).entity.id, "e1.1");
	answerOf(await within(alice.delete({ target: { id: "e1.1" } })));
	answerOf(await within(bob.create(note("omega"))));
	const now = answerOf(await within(alice.read({ target: { kind: "note", name: "omega" } })));
	assert.deepEqual([now.position, now.entity.id, now.entity.created.writer], [4, "e4.1", "bob"]);
	assert.equal(answerOf(await within(alice.read({ target: { id: "e1.1" } }))).entity, null, "the old identity is never reused");
});

test("an invalid target and an unknown kind are refused remotely as the store refuses them", async (t) => {
	const { clients: { alice }, store } = await served(t, { callers: ["alice"] });
	for (const target of [{}, { kind: "note" }, { name: "alpha" }, { id: "e1.1", kind: "note" }, { kind: "nope", name: "alpha" }]) {
		const ending = await within(alice.read({ target }));
		assert.equal(ending.ending, "refused", JSON.stringify(target));
		assert.deepEqual(ending.refusal, store.read({ target }).refusal);
	}
});
