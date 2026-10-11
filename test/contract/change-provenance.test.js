// change-provenance (carried from entity-store) - remote readers see when each change was made and the writer
// the host named (zorg's target, EM5, EM6, EM8; zorg's D13; E5).
//
// Cases: a remote reader sees, for an entity another caller created and a third changed, `created` and
// `changed` each with the change's position, the store's time in UTC to the millisecond, and the writer the
// host named from each caller's evidence; the time is the store's, never the caller's; a find shows the same;
// and a deleted entity reads as absent while the change log keeps each change's time and writer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { within } from "../support/topology.js";
import { answerOf, note, served, T0 } from "../support/serving.js";

test("a remote reader sees each change's position, time and the writer the host named, for creates and updates made by other callers", async (t) => {
	const { clients: { alice, bob, carol }, setTime } = await served(t, { callers: ["alice", "bob", "carol"] });
	answerOf(await within(alice.create(note("alpha"))));
	setTime(T0 + 300_000);
	answerOf(await within(bob.update({ target: { kind: "note", name: "alpha" }, body: { summary: "bob's" } })));
	const read = answerOf(await within(carol.read({ target: { id: "e1.1" } })));
	assert.deepEqual(read.entity.created, { position: 1, at: "2026-10-09T10:00:00.000Z", writer: "alice" });
	assert.deepEqual(read.entity.changed, { position: 2, at: "2026-10-09T10:05:00.000Z", writer: "bob" });
	const found = answerOf(await within(carol.find({ kind: "note" })));
	assert.deepEqual(found.entries[0], read.entity, "a find shows the same provenance");
});

test("a change's time is the store's time, to the millisecond, whatever the caller's clock says", async (t) => {
	const { clients: { alice }, setTime, topology } = await served(t, { callers: ["alice"] });
	topology.hooks.advanceCallClock(123_456);
	setTime(T0 + 1.9);
	const made = answerOf(await within(alice.create(note("alpha"))));
	assert.equal(made.entity.created.at, "2026-10-09T10:00:00.001Z", "floored to the millisecond");
	setTime(T0 - 5000);
	const later = answerOf(await within(alice.update({ target: { id: "e1.1" }, name: "beta" })));
	assert.equal(later.entity.changed.at, "2026-10-09T10:00:00.001Z", "and never earlier than a change already made");
});

test("a deleted entity reads as absent remotely, while the change log keeps each change's time and writer", async (t) => {
	const { clients: { alice, bob }, storage, setTime } = await served(t);
	answerOf(await within(alice.create(note("alpha"))));
	setTime(T0 + 60_000);
	answerOf(await within(alice.delete({ target: { kind: "note", name: "alpha" } })));
	assert.deepEqual(answerOf(await within(bob.read({ target: { id: "e1.1" } }))), { position: 2, entity: null });
	assert.deepEqual(answerOf(await within(bob.read({ target: { kind: "note", name: "alpha" } }))), { position: 2, entity: null });
	const changes = storage.records().filter((r) => r.type === "change");
	assert.deepEqual(changes.map((c) => [c.position, c.at, c.writer]), [[1, "2026-10-09T10:00:00.000Z", "alice"], [2, "2026-10-09T10:01:00.000Z", "alice"]]);
});
