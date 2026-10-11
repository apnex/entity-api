// ask-application-policy - before each operation the host asks the application whether the caller may act;
// it never decides (zorg's target, EM13; E5).
//
// Cases: a remote fixture observes the policy asked before each of the six operations, with the operation,
// the input, the caller's evidence, the writer named, the target and whether the write is a recognised
// repeat; EM13's synchronous order of a write - writer, retention and digest, target resolution, policy,
// store - observed step by step for a create, an update, a delete, a recognised repeat and a reused identity;
// no change lands between a ruling and its write; a denial is returned unchanged and takes no position, for
// every operation; zorg's rule as a fixture application, end to end; a repeated rename whose old name another
// agent has since taken; and a policy that throws, rules asynchronously, rules in another form, or allows a
// write no writer was named for, each ending the invocation unknown with nothing written.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTopology, within } from "../support/topology.js";
import { answerOf, clientOf, note, openStore, serve } from "../support/serving.js";
import { policyRefusal, recordingStore, writerOnlyPolicy } from "../support/policies.js";

async function setup(t, { policy, nameWriter, callers = ["alice", "bob"], log = [] } = {}) {
	const topology = await openTopology({ callers });
	t.after(() => topology.close());
	const opened = openStore();
	const questions = [];
	const asked = (question) => { log.push("policy"); questions.push(question); return policy ? policy(question) : { allowed: true }; };
	await serve(topology, {
		store: recordingStore(opened.store, log),
		nameWriter: (caller) => { log.push("writer"); return nameWriter ? nameWriter(caller) : caller.evidence.node; },
		policy: asked,
	});
	const clients = Object.fromEntries(callers.map((c) => [c, clientOf(topology, c)]));
	return { topology, log, questions, clients, ...opened };
}

const position = (store) => store.historyBound().answer.position;

test("the policy is asked before each of the six operations, with the operation, the input, the caller's evidence, the writer named, the target and whether it is a recognised repeat", async (t) => {
	const { clients: { alice, bob }, questions } = await setup(t);
	const made = answerOf(await within(alice.create(note("alpha", ["t:x"]))));
	answerOf(await within(bob.update({ target: { kind: "note", name: "alpha" }, body: { summary: "two" } })));
	answerOf(await within(bob.read({ target: { id: "e1.1" } })));
	answerOf(await within(bob.findPage({ kind: "note", tags: ["t:x"] })));
	answerOf(await within(alice.historyBound()));
	answerOf(await within(alice.delete({ target: { id: "e1.1" }, expectedRevision: 2 })));
	assert.deepEqual(questions.map((q) => q.operation), ["create", "update", "read", "find", "history-bound", "delete"]);
	assert.deepEqual(questions.map((q) => q.input), [note("alpha", ["t:x"]), { target: { kind: "note", name: "alpha" }, body: { summary: "two" } }, { target: { id: "e1.1" } }, { kind: "note", tags: ["t:x"] }, {}, { target: { id: "e1.1" }, expectedRevision: 2 }]);
	assert.deepEqual(questions.map((q) => q.evidence), ["alice", "bob", "bob", "bob", "alice", "alice"].map((node) => ({ kind: "test-node", node })));
	assert.deepEqual(questions.map((q) => q.delivery.source.originNodeId), ["alice", "bob", "bob", "bob", "alice", "alice"]);
	assert.deepEqual(questions.map((q) => q.writer), ["alice", "bob", null, null, null, "alice"], "a writer is named for each write only");
	assert.deepEqual(questions.map((q) => q.target?.id ?? null), [null, "e1.1", null, null, null, "e1.1"], "an update's and a delete's target is resolved");
	assert.deepEqual(questions[1].target, made.entity, "the target is the entity as it stood when the policy ruled");
	assert.deepEqual(questions[5].target.revision, 2);
	assert.deepEqual(questions.map((q) => q.repeat), [false, false, false, false, false, false]);
	for (const q of questions) {
		assert.deepEqual(Object.keys(q).sort(), ["delivery", "evidence", "input", "operation", "repeat", "target", "writer"]);
		assert.ok(Object.isFrozen(q) && Object.isFrozen(q.input), "the question and its input are frozen, so the policy cannot change what the store is given");
	}
});

test("a write is handled in EM13's order: writer, retention and digest, target resolution, policy, store; a read is ruled on before the store answers", async (t) => {
	const { clients: { alice }, log } = await setup(t, { callers: ["alice"] });
	const steps = async (call) => { log.length = 0; await within(call()); return [...log]; };
	assert.deepEqual(await steps(() => alice.create(note("alpha"))), ["writer", "checkRepeat", "policy", "create"]);
	const renamed = await within(alice.update({ target: { id: "e1.1" }, name: "beta" }));
	assert.equal(renamed.ending, "answered");
	const invocation = renamed.invocation;
	assert.deepEqual(await steps(() => alice.update({ target: { id: "e1.1" }, name: "beta" }, { invocation, repeat: true })), ["writer", "checkRepeat", "policy"], "a recognised repeat: no target resolution, and no write");
	assert.deepEqual(await steps(() => alice.update({ target: { id: "e1.1" }, name: "gamma" }, { invocation })), ["writer", "checkRepeat", "read", "policy", "update"], "a reused identity: the target is resolved and the store refuses it");
	assert.deepEqual(await steps(() => alice.update({ target: { kind: "note", name: "beta" }, tags: ["a:b"] })), ["writer", "checkRepeat", "read", "policy", "update"]);
	assert.deepEqual(await steps(() => alice.delete({ target: { id: "e1.1" } })), ["writer", "checkRepeat", "read", "policy", "delete"]);
	assert.deepEqual(await steps(() => alice.read({ target: { id: "e1.1" } })), ["policy", "read"]);
	assert.deepEqual(await steps(() => alice.findPage({ kind: "note" })), ["policy", "find"]);
	assert.deepEqual(await steps(() => alice.find({ kind: "note" })), ["policy", "find"]);
	assert.deepEqual(await steps(() => alice.historyBound()), ["policy", "historyBound"]);
});

test("a recognised repeat is ruled on as one, and a reused identity as a fresh write whose target is resolved", async (t) => {
	const { clients: { alice }, questions } = await setup(t, { callers: ["alice"] });
	const first = await within(alice.create(note("alpha")));
	answerOf(await within(alice.create(note("alpha"), { invocation: first.invocation, repeat: true })));
	const update = await within(alice.update({ target: { id: "e1.1" }, name: "beta" }));
	const reused = await within(alice.update({ target: { id: "e1.1" }, name: "gamma" }, { invocation: update.invocation }));
	assert.equal(reused.refusal.code, "identity-reused");
	assert.deepEqual(questions.map((q) => [q.operation, q.repeat, q.target?.name ?? null]), [["create", false, null], ["create", true, null], ["update", false, "alpha"], ["update", false, "beta"]]);
});

test("no change lands between a ruling and its write: under concurrent writes from two callers, each write's ruling saw the revision it then wrote over", async (t) => {
	const { clients: { alice, bob }, questions } = await setup(t);
	answerOf(await within(alice.create({ kind: "any", name: "counter", tags: [], body: 0 })));
	const endings = await within(Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? alice : bob).update({ target: { kind: "any", name: "counter" }, body: i }))));
	const revisions = endings.map((e) => answerOf(e).entity.revision).sort((a, b) => a - b);
	assert.deepEqual(revisions, Array.from({ length: 12 }, (_, i) => i + 2));
	const ruled = questions.filter((q) => q.operation === "update");
	const written = new Map(endings.map((e) => [JSON.stringify(answerOf(e).entity.body), answerOf(e).entity.revision]));
	for (const q of ruled) assert.equal(written.get(JSON.stringify(q.input.body)), q.target.revision + 1, "the write took the revision after the one its ruling saw");
});

test("a denial is the policy's refusal, returned unchanged, for every operation, and no denial takes a position or reaches the store", async (t) => {
	const refusal = policyRefusal("not-writer", { writer: "somebody", nested: { list: [1, "two", null] } });
	let deny = false;
	const { clients: { alice }, store, log } = await setup(t, { callers: ["alice"], policy: () => deny ? { allowed: false, refusal } : { allowed: true } });
	answerOf(await within(alice.create(note("alpha"))));
	deny = true;
	log.length = 0;
	const endings = await within(Promise.all([
		alice.create(note("beta")), alice.update({ target: { id: "e1.1" }, name: "x" }), alice.delete({ target: { id: "e1.1" } }),
		alice.read({ target: { id: "e1.1" } }), alice.findPage({ kind: "note" }), alice.historyBound(),
	]));
	for (const e of endings) {
		assert.equal(e.ending, "refused", e.operation);
		assert.deepEqual(e.refusal, refusal, `${e.operation}: the refusal unchanged`);
	}
	assert.equal(position(store), 1, "no denial took a position");
	assert.deepEqual(log.filter((s) => ["create", "update", "delete", "read", "find", "historyBound"].includes(s)), ["read", "read"], "the store answered only the target resolutions, before the rulings");
	const whole = await within(alice.find({ kind: "note" }));
	assert.deepEqual([whole.ending, whole.refusal], ["refused", refusal], "a whole find ends refused as its page was");
});

test("zorg's rule as a fixture application: anyone creates and reads, only the writer updates or deletes, a target that does not exist is the store's to refuse, and a write with no writer named is refused", async (t) => {
	const { clients: { alice, bob, carol }, store } = await setup(t, {
		callers: ["alice", "bob", "carol"],
		policy: writerOnlyPolicy(),
		nameWriter: (caller) => caller.evidence.node === "carol" ? null : caller.evidence.node,
	});
	answerOf(await within(alice.create(note("alpha"))));
	answerOf(await within(bob.read({ target: { kind: "note", name: "alpha" } })), "anyone reads");
	for (const call of [() => bob.update({ target: { id: "e1.1" }, name: "stolen" }), () => bob.delete({ target: { kind: "note", name: "alpha" } })]) {
		const ending = await within(call());
		assert.equal(ending.ending, "refused");
		assert.deepEqual(ending.refusal, policyRefusal("not-writer", { writer: "alice" }));
	}
	const missing = await within(bob.update({ target: { id: "e9.1" }, name: "x" }));
	assert.deepEqual([missing.refusal.part, missing.refusal.code], ["entity-store", "not-found"], "the policy allows a target that does not exist; the store refuses it");
	const nobody = await within(carol.create(note("carols")));
	assert.deepEqual(nobody.refusal, policyRefusal("invalid-identity", { identity: null, node: "carol" }));
	answerOf(await within(carol.read({ target: { id: "e1.1" } })), "a read needs no writer");
	assert.equal(position(store), 1, "no denial took a position");
	assert.equal(answerOf(await within(alice.update({ target: { id: "e1.1" }, name: "renamed" }))).entity.changed.writer, "alice", "the writer updates");
	assert.equal(answerOf(await within(alice.delete({ target: { id: "e1.1" } }))).position, 3, "the writer deletes");
});

test("a repeated rename whose old name another agent has since taken is recognised before the target is resolved, so the policy rules on a repeat and the first answer returns", async (t) => {
	const questions = [];
	const { clients: { alice, bob }, store } = await setup(t, { policy: writerOnlyPolicy(questions) });
	answerOf(await within(alice.create(note("old"))));
	const input = { target: { kind: "note", name: "old" }, name: "new" };
	const first = await within(alice.update(input));
	answerOf(first);
	const bobs = answerOf(await within(bob.create(note("old"))));
	const repeat = await within(alice.update(input, { invocation: first.invocation, repeat: true }));
	assert.deepEqual(repeat.answer, first.answer, "the repeat returns the first answer");
	assert.equal(position(store), 3, "and takes no position");
	const asked = questions.at(-1);
	assert.deepEqual([asked.operation, asked.repeat, asked.target, asked.writer], ["update", true, null, "alice"]);
	assert.deepEqual(store.read({ target: { kind: "note", name: "old" } }).answer.entity, bobs.entity, "bob's entity is untouched");
	const fresh = await within(alice.update(input));
	assert.deepEqual(fresh.refusal, policyRefusal("not-writer", { writer: "bob" }), "the same rename under a new invocation is a fresh write, ruled on against bob's entity");
});

test("a policy that throws, rules with a promise, rules in another form or refuses with no refusal record ends the invocation unknown with operation-failed, and nothing is written", async (t) => {
	const rulings = [
		() => { throw new Error("policy broke"); },
		() => Promise.resolve({ allowed: true }),
		() => Promise.reject(new Error("a late rejection, consumed")),
		() => ({ allowed: "yes" }),
		() => null,
		() => ({ allowed: false }),
		() => ({ allowed: false, refusal: { code: "no" } }),
	];
	let which = 0;
	const { clients: { alice }, store } = await setup(t, { callers: ["alice"], policy: (q) => rulings[which](q) });
	for (which = 0; which < rulings.length; which++) {
		for (const call of [() => alice.create(note(`n${which}`)), () => alice.read({ target: { id: "e1.1" } })]) {
			const ending = await within(call());
			assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "operation-failed", null], `ruling ${which}, ${ending.operation}`);
		}
	}
	assert.equal(position(store), 0);
	await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a policy that allows a write for which the writer naming named no writer ends the invocation unknown, and nothing is written", async (t) => {
	const { clients: { alice }, store, questions } = await setup(t, { callers: ["alice"], nameWriter: () => null });
	const ending = await within(alice.create(note("alpha")));
	assert.deepEqual([ending.ending, ending.reason], ["unknown", "operation-failed"]);
	assert.deepEqual([questions[0].writer, questions[0].repeat], [null, false]);
	assert.equal(position(store), 0);
});
