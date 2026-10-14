// peer-identity-evidence (carried from operation-call) - the application's policy check receives the caller's
// evidence (zorg's target, EM11, EM13; zorg's D26, D31; E5).
//
// Cases: the policy and the writer naming each receive the evidence function's answer for the request, read
// once into one deeply frozen JSON snapshot equal to it, and AGP's delivery context as AGP gave it to the
// evidence function, naming the caller's node as the origin; an evidence function answering asynchronously is
// awaited; with no evidence function the evidence is null and the delivery context still arrives; an evidence
// function that fails, and evidence that is not plain JSON data - read through shape-check's readPlainJson,
// running none of its code (zorg's D54, D55): a getter, which is never run, a class instance, an inherited, a
// non-enumerable or a symbol field, or a promise within, which is observed - end the invocation unknown with
// operation-failed before the writer naming or the policy is asked, no rejection unhandled.
import assert from "node:assert/strict";
import { test } from "node:test";
import { within } from "../support/topology.js";
import { answerOf, note, served } from "../support/serving.js";

test("the policy and the writer naming receive the evidence function's answer, as one deeply frozen JSON snapshot of it, and AGP's delivery context as the evidence function was given it", async (t) => {
	const given = [];
	const answers = [];
	const policySaw = [];
	const writerSaw = [];
	const { clients: { alice, bob } } = await served(t, {
		evidence: (delivery) => {
			given.push(delivery);
			const answer = { kind: "agp-session", node: delivery.source.originNodeId, principal: delivery.source.originNodeId, proved: false };
			answers.push(answer);
			return answer;
		},
		nameWriter: (caller) => { writerSaw.push(caller); return caller.evidence.principal; },
		policy: (q) => { policySaw.push(q); return { allowed: true }; },
	});
	answerOf(await within(alice.create(note("alpha"))));
	answerOf(await within(bob.read({ target: { id: "e1.1" } })));
	assert.equal(policySaw.length, 2);
	for (const [i, q] of policySaw.entries()) {
		assert.deepEqual(q.evidence, answers[i], "the evidence function's answer");
		assert.notEqual(q.evidence, answers[i], "a snapshot of it, not the object the application holds");
		assert.ok(Object.isFrozen(q.evidence), "frozen");
		assert.equal(q.delivery, given[i], "the delivery context the evidence function was given");
	}
	assert.equal(writerSaw[0].evidence, policySaw[0].evidence, "the writer naming and the policy share one snapshot");
	assert.equal(writerSaw[0].delivery, given[0]);
	assert.deepEqual(policySaw.map((q) => [q.delivery.source.originNodeId, q.delivery.source.endpoint, q.delivery.destination]), [["alice", "operation-call/replies", "store/create"], ["bob", "operation-call/replies", "store/read"]]);
	assert.deepEqual(policySaw.map((q) => q.evidence.principal), ["alice", "bob"]);
});

test("an evidence function answering asynchronously is awaited, and its answer is the caller's evidence", async (t) => {
	const seen = [];
	const { clients: { alice } } = await served(t, {
		callers: ["alice"],
		evidence: async (delivery) => { await new Promise((resolve) => setTimeout(resolve, 5)); return { late: true, node: delivery.source.originNodeId }; },
		policy: (q) => { seen.push(q.evidence); return { allowed: true }; },
	});
	assert.equal(answerOf(await within(alice.create(note("alpha")))).entity.created.writer, "alice");
	assert.deepEqual(seen, [{ late: true, node: "alice" }]);
});

test("with no evidence function the caller's evidence is null, and AGP's delivery context still arrives", async (t) => {
	const seen = [];
	const { clients: { alice } } = await served(t, {
		callers: ["alice"],
		evidence: null,
		nameWriter: (caller) => { seen.push(["writer", caller.evidence, caller.delivery.source.originNodeId]); return caller.delivery.source.originNodeId; },
		policy: (q) => { seen.push(["policy", q.evidence, q.delivery.source.originNodeId]); return { allowed: true }; },
	});
	answerOf(await within(alice.create(note("alpha"))));
	assert.deepEqual(seen, [["writer", null, "alice"], ["policy", null, "alice"]]);
});

test("an evidence function that fails ends the invocation unknown with operation-failed, before the writer naming or the policy is asked", async (t) => {
	const asked = [];
	const { clients: { alice }, store } = await served(t, {
		callers: ["alice"],
		evidence: () => { throw new Error("no session record"); },
		nameWriter: () => { asked.push("writer"); return "alice"; },
		policy: () => { asked.push("policy"); return { allowed: true }; },
	});
	for (const call of [() => alice.create(note("alpha")), () => alice.read({ target: { id: "e1.1" } })]) {
		const ending = await within(call());
		assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "operation-failed", null]);
	}
	assert.deepEqual(asked, []);
	assert.equal(store.historyBound().answer.position, 0);
});

test("evidence that is not plain JSON data, or that cannot be read, ends the invocation unknown with operation-failed, before the writer naming or the policy is asked", async (t) => {
	const asked = [];
	const cyclic = { node: "alice" };
	cyclic.self = cyclic;
	const answers = [
		() => new Date(0),
		() => ({ node: "alice", at: () => 0 }),
		() => cyclic,
		() => ({ node: "alice", n: Number.NaN }),
		() => ({ get node() { throw new Error("a getter that throws"); } }),
		() => ({ node: "alice", nested: [1, undefined] }),
		() => ({ get node() { ran.push("a getter giving a name"); return "alice"; } }),
		() => new (class Evidence { constructor() { this.node = "alice"; } })(),
		() => Object.create({ node: "alice" }),
		() => Object.defineProperty({ node: "alice" }, "hidden", { value: 1 }),
		() => ({ node: "alice", [Symbol("extra")]: 1 }),
		() => ({ node: "alice", then: Promise.reject(new Error("evidence holding a promise, rejecting at once")) }),
		() => ({ node: "alice", nested: { get then() { ran.push("a then getter"); return undefined; } } }),
	];
	const ran = [];
	const escaped = [];
	const onUnhandled = (reason) => { escaped.push(reason); };
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	let which = 0;
	const { clients: { alice }, store } = await served(t, {
		callers: ["alice"],
		evidence: () => answers[which](),
		nameWriter: () => { asked.push("writer"); return "alice"; },
		policy: () => { asked.push("policy"); return { allowed: true }; },
	});
	for (which = 0; which < answers.length; which++) {
		for (const call of [() => alice.create(note("alpha")), () => alice.read({ target: { id: "e1.1" } })]) {
			const ending = await within(call());
			assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "operation-failed", null], `evidence ${which}, ${ending.operation}`);
		}
	}
	assert.deepEqual(asked, []);
	assert.equal(store.historyBound().answer.position, 0);
	assert.deepEqual(ran, [], "no getter of the evidence was run");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(escaped, [], "no rejection went unhandled");
});
