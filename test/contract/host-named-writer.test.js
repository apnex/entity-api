// host-named-writer - on the host half, the writer recorded for each remote change is the one the application
// names from the caller's evidence; a writer the client claims is never recorded (zorg's target, EM7, EM13;
// E5).
//
// Cases: each change records the writer the application named from the request's evidence, in the entity and
// in the change log; the writer naming is given the caller's evidence and AGP's delivery context and never the
// input, and is asked for writes only; a client whose evidence is bob, sending a write that claims alice as
// its writer, is refused and nothing is recorded; a writer naming that names no writer leaves the policy to
// refuse; one that throws, gives something other than a string, or answers with a promise ends the invocation
// unknown before the policy is asked, with nothing written; one giving an object with an own then getter,
// giving a function or a non-function, has that then read exactly once, a function observed through it with
// two handlers, and ends the same way, with no rejection unhandled; a repeat is recognised only from the writer that
// made the change, since the writer is part of the digest; a repeated rename whose old name another agent
// has since taken returns the first answer, with the first writer; the evidence reaches the writer naming as a
// deeply frozen JSON snapshot, which it cannot change for the policy or a later request; and describe,
// operation-call's own, names no writer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTopology, within } from "../support/topology.js";
import { answerOf, clientOf, note, openStore, serve } from "../support/serving.js";
import { policyRefusal, writerOnlyPolicy } from "../support/policies.js";

async function setup(t, { nameWriter, policy, callers = ["alice", "bob"] } = {}) {
	const topology = await openTopology({ callers });
	t.after(() => topology.close());
	const opened = openStore();
	const named = [];
	const policyAsked = [];
	await serve(topology, {
		store: opened.store,
		nameWriter: (caller) => { named.push(caller); return nameWriter ? nameWriter(caller) : caller.evidence.node; },
		policy: (q) => { policyAsked.push(q); return policy ? policy(q) : { allowed: true }; },
	});
	return { topology, named, policyAsked, clients: Object.fromEntries(callers.map((c) => [c, clientOf(topology, c)])), ...opened };
}

const changes = (storage) => storage.records().filter((r) => r.type === "change");

test("each remote change records the writer the application named from the caller's evidence, in the entity and in the change log", async (t) => {
	const { clients: { alice, bob }, storage } = await setup(t, { nameWriter: ({ evidence }) => `agent-${evidence.node}` });
	const made = answerOf(await within(alice.create(note("alpha"))));
	assert.deepEqual([made.entity.created.writer, made.entity.changed.writer], ["agent-alice", "agent-alice"]);
	const updated = answerOf(await within(bob.update({ target: { id: "e1.1" }, body: { summary: "bob's" } })));
	assert.deepEqual([updated.entity.created.writer, updated.entity.changed.writer], ["agent-alice", "agent-bob"]);
	answerOf(await within(bob.delete({ target: { id: "e1.1" } })));
	assert.deepEqual(changes(storage).map((c) => c.writer), ["agent-alice", "agent-bob", "agent-bob"]);
	const read = answerOf(await within(alice.read({ target: { id: "e1.1" } })));
	assert.equal(read.entity, null);
});

test("the writer naming is given the caller's evidence and AGP's delivery context, never the input, and is asked for each write only", async (t) => {
	const { clients: { alice }, named } = await setup(t, { callers: ["alice"] });
	answerOf(await within(alice.create(note("alpha"))));
	answerOf(await within(alice.read({ target: { id: "e1.1" } })));
	answerOf(await within(alice.findPage({ kind: "note" })));
	answerOf(await within(alice.historyBound()));
	answerOf(await within(alice.update({ target: { id: "e1.1" }, name: "beta" })));
	answerOf(await within(alice.delete({ target: { id: "e1.1" } })));
	assert.equal(named.length, 3, "asked for the create, the update and the delete only");
	for (const caller of named) {
		assert.deepEqual(Object.keys(caller).sort(), ["delivery", "evidence"]);
		assert.ok(Object.isFrozen(caller));
		assert.deepEqual(caller.evidence, { kind: "test-node", node: "alice" });
		assert.equal(caller.delivery.source.originNodeId, "alice");
		assert.match(caller.delivery.destination, /^store\/(create|update|delete)$/);
	}
});

test("a client whose evidence is bob, sending a write that claims alice as its writer, is refused, and no writer it claims is recorded", async (t) => {
	const { clients: { alice, bob }, named, store } = await setup(t);
	answerOf(await within(alice.create(note("alices"))));
	for (const call of [
		() => bob.create({ ...note("claimed"), writer: "alice" }),
		() => bob.update({ target: { id: "e1.1" }, body: { summary: "x" }, writer: "alice" }),
		() => bob.delete({ target: { id: "e1.1" }, writer: "alice" }),
	]) {
		const ending = await within(call());
		assert.deepEqual([ending.ending, ending.refusal.part, ending.refusal.code], ["refused", "operation-call", "input-misfit"]);
	}
	assert.equal(named.length, 1, "only alice's own create reached the writer naming");
	assert.equal(store.historyBound().answer.position, 1, "nothing bob sent was recorded");
	const plain = answerOf(await within(bob.create(note("bobs"))));
	assert.equal(plain.entity.created.writer, "bob", "bob's own write records bob");
});

test("a writer naming that names no writer leaves the policy to rule, and zorg's rule refuses the write", async (t) => {
	const { clients: { alice }, policyAsked, store } = await setup(t, { callers: ["alice"], nameWriter: () => null, policy: writerOnlyPolicy() });
	const ending = await within(alice.create(note("alpha")));
	assert.deepEqual(ending.refusal, policyRefusal("invalid-identity", { identity: null, node: "alice" }));
	assert.equal(policyAsked[0].writer, null);
	assert.equal(store.historyBound().answer.position, 0);
});

test("a writer naming that throws, gives anything but a string or null, or answers with a promise ends the invocation unknown before the policy is asked, with nothing written", async (t) => {
	const namings = [
		() => { throw new Error("no record"); },
		() => 42,
		() => undefined,
		() => ({ writer: "alice" }),
		() => Promise.resolve("alice"),
		() => Promise.reject(new Error("a late rejection, consumed")),
	];
	let which = 0;
	const { clients: { alice }, policyAsked, store } = await setup(t, { callers: ["alice"], nameWriter: (c) => namings[which](c) });
	for (which = 0; which < namings.length; which++) {
		const ending = await within(alice.create(note(`n${which}`)));
		assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "operation-failed", null], `naming ${which}`);
	}
	assert.equal(policyAsked.length, 0);
	assert.equal(store.historyBound().answer.position, 0);
	await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a writer naming giving an object with an own then getter, giving a function or a non-function, has that then read exactly once, a function observed through it with two handlers, and ends the invocation unknown before the policy is asked, with nothing written and no rejection unhandled", async (t) => {
	const escaped = [];
	const onUnhandled = (reason) => { escaped.push(reason); };
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	let reads = 0;
	let observed = [];
	/** The then getter: counts each read, and gives a function forwarding to a promise rejecting at once, or a string. */
	const thenGetter = (gives) => function () {
		reads++;
		if (gives === "a non-function") return "not a function";
		const rejected = Promise.reject(new Error("a writer naming's then getter's promise, rejecting at once"));
		return (onFulfilled, onRejected) => { observed.push([typeof onFulfilled, typeof onRejected]); return rejected.then(onFulfilled, onRejected); };
	};
	let gives = "a function";
	const nameWriter = () => Object.defineProperty({ writer: "alice" }, "then", { get: thenGetter(gives), enumerable: true, configurable: true });
	const { clients: { alice }, policyAsked, store } = await setup(t, { callers: ["alice"], nameWriter });
	for (gives of ["a function", "a non-function"]) {
		reads = 0;
		observed = [];
		const ending = await within(alice.create(note("alpha")));
		assert.equal(reads, 1, `then giving ${gives}: then read exactly once`);
		assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "operation-failed", null], `then giving ${gives}`);
		assert.deepEqual(observed, gives === "a function" ? [["function", "function"]] : [], `then giving ${gives}: a function observed once, through the function read, with two handlers; anything else never called`);
	}
	assert.equal(policyAsked.length, 0, "the policy was never asked");
	assert.equal(store.historyBound().answer.position, 0, "nothing was written");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(escaped, [], "no rejection went unhandled");
});

test("a repeat is recognised only from the writer that made the change: the same invocation and input from another caller is refused as identity-reused", async (t) => {
	const { clients: { alice, bob }, store } = await setup(t);
	const first = await within(alice.create(note("alpha")));
	const fromBob = await within(bob.create(note("alpha"), { invocation: first.invocation, repeat: true }));
	assert.deepEqual([fromBob.refusal.part, fromBob.refusal.code, fromBob.refusal.details], ["entity-store", "identity-reused", { writeId: first.invocation }]);
	const fromAlice = await within(alice.create(note("alpha"), { invocation: first.invocation, repeat: true }));
	assert.deepEqual(fromAlice.answer, first.answer);
	assert.equal(store.historyBound().answer.position, 1);
});

test("a repeated rename whose old name another agent has since taken returns the first answer, with the writer the host first named", async (t) => {
	const { clients: { alice, bob }, store, storage } = await setup(t, { policy: writerOnlyPolicy() });
	answerOf(await within(alice.create(note("old"))));
	const input = { target: { kind: "note", name: "old" }, name: "new" };
	const first = await within(alice.update(input));
	answerOf(await within(bob.create(note("old"))));
	const repeat = await within(alice.update(input, { invocation: first.invocation, repeat: true }));
	assert.deepEqual(repeat.answer, first.answer);
	assert.equal(repeat.answer.entity.changed.writer, "alice");
	assert.deepEqual(changes(storage).map((c) => c.writer), ["alice", "alice", "bob"], "the repeat recorded nothing");
	assert.equal(store.read({ target: { kind: "note", name: "old" } }).answer.entity.created.writer, "bob");
});

test("the evidence reaches the writer naming as a deeply frozen JSON snapshot: a change it tries is refused, and the policy and a later request see the evidence as given", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const opened = openStore();
	const tried = [];
	const policySaw = [];
	await serve(topology, {
		store: opened.store,
		evidence: (delivery) => ({ node: delivery.source.originNodeId, session: { principal: delivery.source.originNodeId, claims: ["a"] } }),
		nameWriter: ({ evidence }) => {
			for (const change of [() => { evidence.node = "mallory"; }, () => { evidence.session.principal = "mallory"; }, () => { evidence.session.claims.push("b"); }]) {
				try { change(); tried.push("changed"); } catch (error) { tried.push(error.constructor.name); }
			}
			return evidence.session.principal;
		},
		policy: (q) => { policySaw.push(JSON.parse(JSON.stringify(q.evidence))); return { allowed: true }; },
	});
	const alice = clientOf(topology, "alice");
	assert.equal(answerOf(await within(alice.create(note("alpha")))).entity.created.writer, "alice");
	answerOf(await within(alice.update({ target: { id: "e1.1" }, name: "beta" })));
	assert.deepEqual(tried, ["TypeError", "TypeError", "TypeError", "TypeError", "TypeError", "TypeError"]);
	assert.deepEqual(policySaw, [0, 1].map(() => ({ node: "alice", session: { principal: "alice", claims: ["a"] } })));
});

test("describe, operation-call's own operation, names no writer", async (t) => {
	const { topology, named, policyAsked } = await setup(t, { callers: ["alice"] });
	const ending = await within(topology.caller("alice").caller.invoke({ host: "host-a", service: "store", operation: "describe", input: {}, bound: 5000 }));
	assert.equal(answerOf(ending).service, "store");
	assert.deepEqual([named.length, policyAsked.length], [0, 0]);
});
