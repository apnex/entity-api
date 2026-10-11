// advertiser-instance-select (carried from operation-call) - a caller names the host it means, so another host
// claiming the same store cannot answer in its place (zorg's target, EM11; zorg's D7; E8).
//
// Cases: two hosts serve stores under the same name, so AGP sees two advertisers of every endpoint; a client
// pinned to each reaches only that host's store, and every call it makes is pinned to it; a client naming a
// host that serves nothing while the other advertises the store is refused by AGP at its admission deadline,
// never answered by the other; and once a named host stops serving, its client's calls are not delivered and
// the other host is never asked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openTopology, within } from "../support/topology.js";
import { answerOf, clientOf, note, openStore, serve } from "../support/serving.js";

async function twoHosts(t) {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const a = openStore();
	const b = openStore();
	const askedA = [];
	const askedB = [];
	const serverA = await serve(topology, { host: "host-a", store: a.store, policy: (q) => { askedA.push(q.operation); return { allowed: true }; } });
	const serverB = await serve(topology, { host: "host-b", store: b.store, policy: (q) => { askedB.push(q.operation); return { allowed: true }; } });
	return { topology, a, b, askedA, askedB, serverA, serverB };
}

test("two hosts advertise the same store's endpoints; a client pinned to each reaches only that host's store, every call pinned to it", async (t) => {
	const { topology, a, b, askedA, askedB } = await twoHosts(t);
	const advertisers = topology.caller("alice").node.operations.routes().candidates.filter((r) => r.endpoint === "store/create").map((r) => r.originNodeId).sort();
	assert.deepEqual(advertisers, ["host-a", "host-b"]);
	const toA = clientOf(topology, "alice", { host: "host-a" });
	const toB = clientOf(topology, "alice", { host: "host-b" });
	answerOf(await within(toA.create(note("on-a"))));
	answerOf(await within(toB.create(note("on-b"))));
	assert.equal(a.store.read({ target: { kind: "note", name: "on-a" } }).answer.entity.name, "on-a");
	assert.equal(a.store.read({ target: { kind: "note", name: "on-b" } }).answer.entity, null);
	assert.equal(b.store.read({ target: { kind: "note", name: "on-b" } }).answer.entity.name, "on-b");
	assert.deepEqual(answerOf(await within(toA.find({ kind: "note" }))).entries.map((e) => e.name), ["on-a"]);
	assert.deepEqual(answerOf(await within(toB.find({ kind: "note" }))).entries.map((e) => e.name), ["on-b"]);
	assert.deepEqual([askedA, askedB], [["create", "find"], ["create", "find"]]);
	const calls = topology.caller("alice").calls;
	assert.deepEqual(calls.map((c) => c.host), ["host-a", "host-b", "host-a", "host-b"], "every call names its host");
});

test("a client naming a host that serves nothing, while another host advertises the store, is refused by AGP and never answered by the other", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const a = openStore();
	const asked = [];
	await serve(topology, { host: "host-a", store: a.store, policy: (q) => { asked.push(q); return { allowed: true }; } });
	const toB = clientOf(topology, "alice", { host: "host-b", bound: 500 });
	const ending = await topology.hooks.settleOnAgpClock(toB.create(note("misdirected")));
	assert.deepEqual([ending.ending, ending.agpCode, ending.proxyCode], ["not-delivered", "INSTANCE_UNREACHABLE", null]);
	const toNowhere = await topology.hooks.settleOnAgpClock(clientOf(topology, "alice", { host: "host-nowhere", bound: 500 }).read({ target: { id: "e1.1" } }));
	assert.equal(toNowhere.ending, "not-delivered");
	assert.deepEqual(asked, [], "host-a was never asked");
	assert.equal(a.store.historyBound().answer.position, 0);
});

test("once the named host stops serving, its client's calls are not delivered, and the other host is never asked", async (t) => {
	const { topology, a, askedA, serverB } = await twoHosts(t);
	await serverB.close();
	for (const op of ["create", "update", "delete", "read", "find", "history-bound", "describe"]) await topology.hooks.gone("host-b", `store/${op}`);
	const toB = clientOf(topology, "alice", { host: "host-b", bound: 500 });
	const ending = await topology.hooks.settleOnAgpClock(toB.create(note("orphan")));
	assert.equal(ending.ending, "not-delivered");
	assert.ok(["INSTANCE_UNREACHABLE", "NO_ROUTE"].includes(ending.agpCode), ending.agpCode);
	assert.deepEqual(askedA, []);
	assert.equal(a.store.historyBound().answer.position, 0);
});
