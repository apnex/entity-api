// honest-call-ending (carried from operation-call) - every remote operation ends honestly, even when the
// honest answer is unknown (zorg's target, EM12; zorg's D8; E6, E15).
//
// Cases, with the call bound on a controlled clock: each operation ends exactly once, in one of the four
// endings, each a frozen record of EM12's fields; a write whose answer is lost ends unknown at its bound,
// though applied, and its repeat recovers the first answer; a store that stops when an append fails ends that
// write and every later operation unknown with operation-failed, its write not applied; a call to a host that
// is not reachable ends not delivered with AGP's code; and a lost channel ends a waiting call unknown at its
// bound, with the delivery report AGP gave.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStoragePort } from "@apnex/entity-store";
import { openTopology, until, within } from "../support/topology.js";
import { answerOf, clientOf, note, openStore, serve } from "../support/serving.js";

const FIELDS = {
	answered: ["answer", "attempt", "ending", "invocation", "operation"],
	refused: ["attempt", "ending", "invocation", "operation", "refusal"],
	"not-delivered": ["agpCode", "attempt", "earlierAttemptsUncertain", "ending", "invocation", "operation", "proxyCode"],
	unknown: ["agpCode", "attempt", "deliveryReport", "ending", "invocation", "operation", "reason"],
};
const honest = (ending) => {
	assert.ok(Object.isFrozen(ending), "an ending is frozen");
	assert.deepEqual(Object.keys(ending).sort(), FIELDS[ending.ending], `${ending.ending} holds EM12's fields`);
	return ending;
};

/** A host node whose answers are dropped while `drop.on` is true. */
function droppingNode(drop) {
	return (node) => new Proxy(node, {
		get(target, name) {
			if (name !== "send" && name !== "sendDirectPeer") { const v = Reflect.get(target, name); return typeof v === "function" ? v.bind(target) : v; }
			return async (from, to, payload, options) => {
				if (drop.on && payload?.type === "end") { drop.count++; return { messageId: `dropped-${drop.count}` }; }
				return target[name](from, to, payload, options);
			};
		},
	});
}

test("each operation ends exactly once, answered, refused, not delivered or unknown, as a frozen record of EM12's fields", async (t) => {
	const drop = { on: false, count: 0 };
	const topology = await openTopology({ callers: ["alice"], wrapHostNode: droppingNode(drop) });
	t.after(() => topology.close());
	const { store } = openStore();
	await serve(topology, { store });
	const client = clientOf(topology, "alice", { bound: 500 });
	honest(await within(client.create(note("alpha"))));
	honest(await within(client.read({ target: { kind: "nope", name: "x" } })));
	const elsewhere = clientOf(topology, "alice", { host: "host-c", bound: 500 }).historyBound();
	const notDelivered = honest(await topology.hooks.settleOnAgpClock(elsewhere));
	assert.deepEqual([notDelivered.ending, notDelivered.agpCode], ["not-delivered", "INSTANCE_UNREACHABLE"], "AGP refuses the send at its admission deadline");
	drop.on = true;
	for (const call of [() => client.read({ target: { id: "e1.1" } }), () => client.findPage({ kind: "note" }), () => client.historyBound(), () => client.update({ target: { id: "e1.1" }, name: "b" }), () => client.delete({ target: { id: "e1.1" } })]) {
		const pending = call();
		const settled = [];
		pending.then((e) => settled.push(e));
		await until(() => drop.count > 0, "the answer to be dropped");
		drop.count = 0;
		topology.hooks.advanceCallClock(499);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(settled.length, 0, "no ending before the bound");
		topology.hooks.advanceCallClock(1);
		const ending = honest(await within(pending));
		assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "bound-passed", null]);
	}
});

test("a write whose answer is lost ends unknown though it was applied, and repeating its invocation recovers the first answer with no second change", async (t) => {
	const drop = { on: true, count: 0 };
	const topology = await openTopology({ callers: ["alice"], wrapHostNode: droppingNode(drop) });
	t.after(() => topology.close());
	const { store } = openStore();
	await serve(topology, { store });
	const client = clientOf(topology, "alice", { bound: 1000 });
	const pending = client.create(note("alpha"));
	await until(() => drop.count === 1, "the answer to be dropped");
	topology.hooks.advanceCallClock(1000);
	const lost = honest(await within(pending));
	assert.equal(lost.ending, "unknown");
	assert.equal(store.historyBound().answer.position, 1, "the write was applied");
	drop.on = false;
	const repeat = honest(await within(client.create(note("alpha"), { invocation: lost.invocation, repeat: true })));
	assert.deepEqual([repeat.ending, repeat.answer.position, repeat.invocation], ["answered", 1, lost.invocation]);
	assert.equal(store.historyBound().answer.position, 1);
});

test("a store that stops when an append fails ends the write and every later operation unknown with operation-failed, the write not applied", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const memory = createMemoryStoragePort();
	let fail = false;
	const storage = { load: () => memory.load(), append: (record) => { if (fail) throw new Error("disk full"); memory.append(record); } };
	const { store } = openStore({ storage });
	await serve(topology, { store });
	const client = clientOf(topology, "alice");
	answerOf(await within(client.create(note("alpha"))));
	fail = true;
	for (const call of [() => client.create(note("beta")), () => client.read({ target: { id: "e1.1" } }), () => client.historyBound()]) {
		const ending = honest(await within(call()));
		assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "operation-failed", null]);
	}
	assert.equal(memory.records().filter((r) => r.type === "change").length, 1, "the failed write was not applied");
});

test("a call to a host that is not reachable ends not delivered with AGP's code, and a repeat says an earlier attempt may have taken effect", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const client = clientOf(topology, "alice", { host: "host-z" });
	const plain = honest(await within(client.create(note("alpha"))));
	assert.deepEqual([plain.ending, plain.agpCode, plain.proxyCode, plain.earlierAttemptsUncertain], ["not-delivered", "NO_ROUTE", null, false]);
	const repeat = honest(await within(client.create(note("alpha"), { invocation: plain.invocation, repeat: true })));
	assert.equal(repeat.earlierAttemptsUncertain, true);
	const read = honest(await within(client.read({ target: { id: "e1.1" } }, { invocation: plain.invocation })));
	assert.equal(read.earlierAttemptsUncertain, false, "a read marks no repeat");
});

test("a channel lost while a call waits ends it unknown at its bound, with the delivery report AGP last gave", async (t) => {
	const held = Promise.withResolvers();
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => { held.resolve(null); return topology.close(); });
	const { store } = openStore();
	let arrived = 0;
	await serve(topology, { store, evidence: (delivery) => { arrived++; return held.promise.then(() => ({ node: delivery.source.originNodeId })); } });
	const client = clientOf(topology, "alice", { bound: 1000 });
	const pending = client.read({ target: { id: "e1.1" } });
	await until(() => arrived === 1, "the request to reach the host");
	topology.hooks.loseChannel("alice", "host-a");
	topology.hooks.advanceCallClock(1000);
	const ending = honest(await within(pending));
	assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "bound-passed", null]);
	assert.ok(["delivered", "unknown", null].includes(ending.deliveryReport));
});
