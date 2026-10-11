// repeat-recognition (carried from entity-store) - the client half passes each invocation's identity as the
// write's identity, so repeating an invocation repeats the write and the store recognises it (zorg's target,
// EM7, EM8; zorg's D4; E4).
//
// The host reads a write's identity from operation-call's envelope, never from the input. Cases: each
// change's write identity in the change log is the invocation identity it was made under; a create, an update
// and a delete, each repeated under the same invocation after its answer was dropped, change the store once,
// take one position, and the repeat returns the first answer; an update naming no expected revision repeated
// inside the history bound is recognised, and at the bound runs afresh and takes a new position; a create
// repeated outside the bound runs afresh and meets its own entity's name as name-taken, and a delete repeated
// outside it finds nothing, as not-found; another input under a retained identity is refused as
// identity-reused; and an input naming a write identity is refused before anything else is asked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTopology, until, within } from "../support/topology.js";
import { answerOf, clientOf, note, openStore, serve, T0 } from "../support/serving.js";

/** A host node whose next answers to the named operations are dropped, as zorg's hub drops them in tests (RT9). */
function dropping(plan) {
	const dropped = [];
	const wrap = (node) => new Proxy(node, {
		get(target, name) {
			if (name !== "send") { const v = Reflect.get(target, name); return typeof v === "function" ? v.bind(target) : v; }
			return async (from, to, payload, options) => {
				if (payload?.type === "end" && plan[payload.operation] > 0) {
					plan[payload.operation]--;
					dropped.push(payload);
					return { messageId: `dropped-${dropped.length}` };
				}
				return target.send(from, to, payload, options);
			};
		},
	});
	return { wrap, dropped };
}

async function setup(t, { plan = {}, historyMs = 60_000 } = {}) {
	const drops = dropping(plan);
	const topology = await openTopology({ callers: ["alice"], wrapHostNode: drops.wrap });
	t.after(() => topology.close());
	const opened = openStore({ historyMs });
	await serve(topology, { store: opened.store });
	return { topology, drops, ...opened, entry: topology.caller("alice"), client: clientOf(topology, "alice", { bound: 1000 }) };
}

const changeRecords = (storage) => storage.records().filter((r) => r.type === "change");
const position = (store) => store.historyBound().answer.position;

test("each change's write identity is the invocation identity it was made under, read from operation-call's envelope", async (t) => {
	const { client, storage, entry } = await setup(t);
	const given = entry.caller.newInvocation();
	const endings = [
		await within(client.create(note("alpha"), { invocation: given })),
		await within(client.update({ target: { id: "e1.1" }, name: "beta" })),
		await within(client.delete({ target: { id: "e1.1" } })),
	];
	assert.equal(endings[0].invocation, given);
	assert.deepEqual(changeRecords(storage).map((r) => r.writeId), endings.map((e) => e.invocation));
	assert.ok(endings.every((e) => !e.attempt.endsWith(e.invocation) && e.attempt !== e.invocation), "the attempt identity is not the write identity");
});

test("a create, an update and a delete, each repeated under the same invocation after its answer was dropped, change the store once, take one position, and the repeat returns the first answer", async (t) => {
	const { client, store, storage, topology, drops } = await setup(t, { plan: { create: 1, update: 1, delete: 1 } });
	const cases = [
		["create", note("alpha"), 1],
		["update", { target: { kind: "note", name: "alpha" }, body: { summary: "two" } }, 2],
		["delete", { target: { id: "e1.1" } }, 3],
	];
	for (const [operation, input, expected] of cases) {
		const pending = client[operation](input);
		await until(() => drops.dropped.length === expected, `the ${operation}'s answer to be dropped`);
		topology.hooks.advanceCallClock(1000);
		const lost = await within(pending);
		assert.deepEqual([lost.ending, lost.reason], ["unknown", "bound-passed"], `the ${operation} ends unknown`);
		assert.equal(position(store), expected, `the ${operation} was applied once`);
		const repeat = await within(client[operation](input, { invocation: lost.invocation, repeat: true }));
		assert.deepEqual(repeat.answer, drops.dropped.at(-1).answer, `the ${operation}'s repeat returns the first answer`);
		assert.equal(repeat.invocation, lost.invocation);
		assert.equal(position(store), expected, `the ${operation}'s repeat took no position`);
	}
	assert.equal(changeRecords(storage).length, 3);
});

test("an update naming no expected revision, repeated one millisecond inside the history bound, is recognised; repeated at the bound it runs afresh and takes a new position", async (t) => {
	const { client, store, setTime } = await setup(t, { historyMs: 1000 });
	answerOf(await within(client.create({ kind: "any", name: "n", tags: [], body: 0 })));
	setTime(T0 + 100);
	const input = { target: { kind: "any", name: "n" }, body: 1 };
	const first = await within(client.update(input));
	setTime(T0 + 1099);
	const inside = await within(client.update(input, { invocation: first.invocation, repeat: true }));
	assert.deepEqual(inside.answer, first.answer);
	assert.equal(position(store), 2);
	setTime(T0 + 1100);
	const outside = answerOf(await within(client.update(input, { invocation: first.invocation, repeat: true })));
	assert.deepEqual([outside.position, outside.entity.revision], [3, 3], "it ran afresh");
	const again = await within(client.update(input, { invocation: first.invocation, repeat: true }));
	assert.deepEqual(again.answer, outside, "and the identity now names the new change");
});

test("a create repeated outside the bound runs afresh and meets its own entity's name as name-taken; a delete repeated outside it finds nothing, as not-found", async (t) => {
	const { client, store, setTime } = await setup(t, { historyMs: 1000 });
	const create = await within(client.create(note("alpha")));
	answerOf(await within(client.create(note("beta"))));
	const deleted = await within(client.delete({ target: { kind: "note", name: "beta" } }));
	assert.equal(answerOf(deleted).position, 3);
	setTime(T0 + 1000);
	const created = await within(client.create(note("alpha"), { invocation: create.invocation, repeat: true }));
	assert.deepEqual([created.refusal.code, created.refusal.details], ["name-taken", { kind: "note", name: "alpha", id: "e1.1" }]);
	const gone = await within(client.delete({ target: { kind: "note", name: "beta" } }, { invocation: deleted.invocation, repeat: true }));
	assert.deepEqual([gone.refusal.code, gone.refusal.details], ["not-found", { target: { kind: "note", name: "beta" } }]);
	assert.equal(position(store), 3);
});

test("another input under a retained invocation is refused as identity-reused, naming the identity, and takes no position", async (t) => {
	const { client, store } = await setup(t);
	const first = await within(client.create(note("alpha")));
	const other = await within(client.create(note("beta"), { invocation: first.invocation, repeat: true }));
	assert.deepEqual([other.refusal.part, other.refusal.code, other.refusal.details], ["entity-store", "identity-reused", { writeId: first.invocation }]);
	const otherOperation = await within(client.delete({ target: { id: "e1.1" } }, { invocation: first.invocation }));
	assert.equal(otherOperation.refusal.code, "identity-reused");
	assert.equal(position(store), 1);
});

test("an input naming a write identity is refused by operation-call as input-misfit; the identity is never taken from the input", async (t) => {
	const { client, store, storage } = await setup(t);
	const first = await within(client.create(note("alpha")));
	const claimed = await within(client.create({ ...note("beta"), writeId: first.invocation }));
	assert.deepEqual([claimed.refusal.part, claimed.refusal.code], ["operation-call", "input-misfit"]);
	const fresh = await within(client.create(note("beta")));
	assert.notEqual(fresh.invocation, first.invocation);
	assert.deepEqual(changeRecords(storage).map((r) => r.writeId), [first.invocation, fresh.invocation]);
	assert.equal(position(store), 2);
});
