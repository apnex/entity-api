// store-refusal (carried from entity-store) - the store's refusals arrive with their reasons intact (zorg's
// target, EM9; zorg's D3, D21; E5).
//
// Cases: every code the store refuses with that a request can carry - identity-reused, unknown-kind,
// invalid-position, position-not-held, invalid-target, empty-update, not-found, revision-moved, invalid-name,
// name-taken, too-many-tags, invalid-tag, duplicate-tag, misfit with shape-check's records, entity-too-large
// and entity-too-deep - reaches the remote caller exactly as the same store gives it locally, a record of
// exactly EM9's fields naming entity-store, taking no position; strings from the input cut to 128 code points
// alike; and the refusals of the parts around the store - operation-call's input-misfit and an application's
// policy - each arrive naming the part that refused, as distinct records. unsafe-number cannot cross AGP in a
// request; it is refused by operation-call before sending (shared-suite.test.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { within } from "../support/topology.js";
import { note, openStore, served, T0 } from "../support/serving.js";
import { policyRefusal } from "../support/policies.js";

const long = (n, c = "a") => c.repeat(n);
let deep = "core";
for (let i = 0; i < 27; i++) deep = [deep];

test("each of the store's refusals reaches the remote caller exactly as the store gives it locally, and none takes a position", async (t) => {
	const { clients: { alice }, store, setTime } = await served(t, { callers: ["alice"], store: { historyMs: 1000, maxEntityBytes: 2048 } });
	const local = openStore({ historyMs: 1000, maxEntityBytes: 2048 });
	let writes = 0;
	const both = async (operation, input, { invocation } = {}) => {
		const method = { "history-bound": "historyBound", find: "findPage" }[operation] ?? operation;
		const ending = await within(alice[method](input, invocation ? { invocation } : {}));
		const writeId = invocation ?? `w${++writes}`;
		const outcome = ["create", "update", "delete"].includes(operation) ? local.store[operation](input, { writer: "alice", writeId }) : local.store[operation](input);
		return { ending, outcome };
	};
	await both("create", note("alpha"));
	await both("create", note("beta"));
	setTime(T0 + 1500);
	local.setTime(T0 + 1500);
	await both("create", note("delta"));
	const reused = await within(alice.create(note("gamma")));
	local.store.create(note("gamma"), { writer: "alice", writeId: reused.invocation });
	const cases = [
		["create", note("other"), "identity-reused", { invocation: reused.invocation }],
		["create", { kind: "nope", name: "x", tags: [], body: 0 }, "unknown-kind"],
		["find", { kind: "note", asOf: 9 }, "invalid-position"],
		["find", { kind: "note", asOf: 0 }, "position-not-held"],
		["update", { target: { kind: "note" }, name: "x" }, "invalid-target"],
		["update", { target: { id: "e1.1" } }, "empty-update"],
		["delete", { target: { kind: "note", name: long(200) } }, "not-found"],
		["update", { target: { id: "e1.1" }, expectedRevision: 7, name: "x" }, "revision-moved"],
		["create", note(long(200, "N")), "invalid-name"],
		["update", { target: { id: "e1.1" }, name: "beta" }, "name-taken"],
		["create", note("t", Array.from({ length: 33 }, (_, i) => `k:v${i}`)), "too-many-tags"],
		["create", note("t", ["k:v", "bad"]), "invalid-tag"],
		["create", note("t", ["k:v", "k:v"]), "duplicate-tag"],
		["create", { kind: "note", name: "m", tags: [], body: { z: 1, summary: 5, pointer: "not a uri" } }, "misfit"],
		["create", { kind: "any", name: "big", tags: [], body: long(3000) }, "entity-too-large"],
		["create", { kind: "any", name: "deep", tags: [], body: deep }, "entity-too-deep"],
	];
	const before = store.historyBound().answer.position;
	for (const [operation, input, code, options] of cases) {
		const { ending, outcome } = await both(operation, input, options);
		assert.equal(ending.ending, "refused", code);
		assert.equal(outcome.refusal.code, code, `the local store refuses as ${code}`);
		assert.deepEqual(ending.refusal, outcome.refusal, `${code} arrives unchanged`);
		assert.equal(ending.refusal.part, "entity-store");
		assert.deepEqual(Object.keys(ending.refusal).sort(), code === "misfit" ? ["code", "details", "fix", "misfits", "part", "what", "why"] : ["code", "details", "fix", "part", "what", "why"]);
	}
	assert.equal(store.historyBound().answer.position, before, "no refusal took a position");
});

test("the refusals of the parts around the store each arrive naming the part that refused, as distinct records", async (t) => {
	const denial = policyRefusal("not-writer", { writer: "bob" });
	const { clients: { alice } } = await served(t, { callers: ["alice"], policy: (q) => (q.operation === "delete" ? { allowed: false, refusal: denial } : { allowed: true }) });
	const misfit = await within(alice.create({ kind: "note", name: "x", tags: [] }));
	assert.deepEqual([misfit.refusal.part, misfit.refusal.code, misfit.refusal.misfits.map((m) => [m.pointer, m.keyword])], ["operation-call", "input-misfit", [["/body", "required"]]]);
	assert.deepEqual((await within(alice.delete({ target: { id: "e1.1" } }))).refusal, denial);
	assert.equal((await within(alice.update({ target: { id: "e1.1" }, name: "x" }))).refusal.part, "entity-store");
});
