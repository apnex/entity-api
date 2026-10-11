// positioned-entity-write (carried from entity-store) - each remote change takes one position in the store's
// order (zorg's target, EM3, EM6; zorg's D33; E3).
//
// Cases: under creates and updates sent at once from two callers, every accepted change takes a position
// greater than every earlier one, none repeats, each create's identity is e<position>.1, and each change is
// one write; every read and find a remote caller makes answers as of the position it reports; a refused write
// and a recognised repeat take no position; and the next change takes the next position.
import assert from "node:assert/strict";
import { test } from "node:test";
import { within } from "../support/topology.js";
import { answerOf, note, served } from "../support/serving.js";

test("changes sent at once from two callers each take one position, rising, never repeating, each a change of one write", async (t) => {
	const { clients: { alice, bob }, storage } = await served(t);
	const creates = await within(Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? alice : bob).create(note(`n${i}`, [`by:${i % 2 ? "alice" : "bob"}`])))));
	const positions = creates.map((e) => answerOf(e).position);
	assert.deepEqual([...positions].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1), "positions 1 to 16, each once");
	for (const e of creates) assert.equal(answerOf(e).entity.id, `e${answerOf(e).position}.1`, "the identity names the position that created it");
	const updates = await within(Promise.all(creates.map((e, i) => (i % 2 ? bob : alice).update({ target: { id: answerOf(e).entity.id }, tags: ["x:y"] }))));
	assert.deepEqual(updates.map((e) => answerOf(e).position).sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 17));
	const records = storage.records().filter((r) => r.type === "change");
	assert.deepEqual(records.map((r) => r.position), Array.from({ length: 32 }, (_, i) => i + 1), "the change log in order, no gap");
	assert.ok(records.every((r) => r.writes.length === 1), "each operation makes a change of one write");
});

test("every remote read and find answers as of the position it reports, while changes interleave", async (t) => {
	const { clients: { alice, bob } } = await served(t);
	const seen = [];
	for (let i = 0; i < 6; i++) {
		answerOf(await within((i % 2 ? alice : bob).create(note(`n${i}`))));
		const [read, page, whole] = await within(Promise.all([alice.read({ target: { kind: "note", name: "n0" } }), bob.findPage({ kind: "note" }), alice.find({ kind: "note" })]));
		seen.push([answerOf(read).position, answerOf(page).position, answerOf(whole).position, answerOf(page).entries.length, answerOf(whole).entries.length]);
	}
	assert.deepEqual(seen, Array.from({ length: 6 }, (_, i) => [i + 1, i + 1, i + 1, i + 1, i + 1]));
	const asOf = answerOf(await within(bob.find({ kind: "note", asOf: 3 })));
	assert.deepEqual([asOf.position, asOf.entries.map((e) => e.name)], [3, ["n0", "n1", "n2"]], "a find as of 3 holds the state at 3");
});

test("a refused write and a recognised repeat take no position, and the next change takes the next one", async (t) => {
	const { clients: { alice } } = await served(t, { callers: ["alice"] });
	const first = await within(alice.create(note("alpha")));
	assert.equal((await within(alice.create(note("alpha")))).refusal.code, "name-taken");
	assert.equal((await within(alice.update({ target: { id: "e9.1" }, name: "x" }))).refusal.code, "not-found");
	assert.equal(answerOf(await within(alice.create(note("alpha"), { invocation: first.invocation, repeat: true }))).position, 1);
	const next = answerOf(await within(alice.create(note("beta"))));
	assert.deepEqual([next.position, next.entity.id], [2, "e2.1"]);
	assert.equal(answerOf(await within(alice.historyBound())).position, 2);
});
