// serve-store-by-name - a host half serves one store's operations as named operations, under a name the
// application chooses (zorg's target, EM10; E8 for a served store).
//
// Cases: each of the six operations is its own AGP endpoint `<name>/<operation>`, observed in AGP's route
// view, beside operation-call's `describe`; an operation the host does not serve has no endpoint, so AGP
// refuses a call to it before any handler runs; `describe` answers EM10's description, every input shape the
// full shape document EM10 writes, ordered by name; two stores served under two names on one node are each
// reached by their own; a name breaking EM1's pattern is refused by operation-call's host and nothing is
// exposed; an input carrying a writer or a write identity is refused as input-misfit before the writer naming,
// the policy or the store is asked; closing withdraws every endpoint; and the arguments a host needs are
// checked as programming errors.
import assert from "node:assert/strict";
import { test } from "node:test";
import { serveStore } from "@apnex/entity-api";
import { openTopology, within } from "../support/topology.js";
import { answerOf, clientOf, note, openStore, serve, SHAPE_DIALECT_ID } from "../support/serving.js";

const D = SHAPE_DIALECT_ID;
const TARGET = { type: "object", additionalProperties: false, properties: { id: { type: "string" }, kind: { type: "string" }, name: { type: "string" } } };
const TAGS = { type: "array", items: { type: "string" } };
// EM10's input shapes, written here from the target's text, independently of entity-api's source.
const EM10_SHAPES = {
	create: { $schema: D, type: "object", required: ["kind", "name", "tags", "body"], additionalProperties: false, properties: { kind: { type: "string" }, name: { type: "string" }, tags: TAGS, body: {} } },
	update: { $schema: D, type: "object", required: ["target"], additionalProperties: false, properties: { target: TARGET, expectedRevision: { type: "integer" }, name: { type: "string" }, tags: TAGS, body: {} } },
	delete: { $schema: D, type: "object", required: ["target"], additionalProperties: false, properties: { target: TARGET, expectedRevision: { type: "integer" } } },
	read: { $schema: D, type: "object", required: ["target"], additionalProperties: false, properties: { target: TARGET } },
	find: { $schema: D, type: "object", required: ["kind"], additionalProperties: false, properties: { kind: { type: "string" }, tags: TAGS, after: { type: "string" }, asOf: { type: "integer" } } },
	"history-bound": { $schema: D, type: "object", additionalProperties: false },
};

/** The endpoints host-a itself originates and exports. */
const hostExports = (topology) => topology.hosts.get("host-a").operations.routeExports().items.filter((r) => r.originNodeId === "host-a").map((r) => r.endpoint);

async function setup(t, options = {}) {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const opened = openStore();
	const asked = [];
	const server = await serve(topology, {
		store: opened.store,
		nameWriter: (c) => { asked.push("writer"); return c.evidence.node; },
		policy: () => { asked.push("policy"); return { allowed: true }; },
		...options,
	});
	return { topology, server, asked, ...opened, raw: topology.caller("alice").caller, client: clientOf(topology, "alice") };
}

test("each operation is served at its own AGP endpoint <name>/<operation>, seen in AGP's route view, beside describe", async (t) => {
	const { topology } = await setup(t);
	const routes = topology.caller("alice").node.operations.routes().candidates.filter((r) => r.originNodeId === "host-a").map((r) => r.endpoint).sort();
	assert.deepEqual(routes, ["store/create", "store/delete", "store/describe", "store/find", "store/history-bound", "store/read", "store/update"]);
	const hostEndpoints = topology.hosts.get("host-a").operations.routeExports().items.filter((r) => r.remoteNodeId === "alice" && r.originNodeId === "host-a" && r.state === "acked").map((r) => r.endpoint).sort();
	assert.deepEqual(hostEndpoints, routes, "the host exports each endpoint to the caller");
});

test("an operation the host does not serve has no endpoint: AGP refuses the call before any handler runs, and nothing is asked", async (t) => {
	const { raw, asked, store } = await setup(t);
	for (const operation of ["follow", "changes-since", "write"]) {
		const ending = await within(raw.invoke({ host: "host-a", service: "store", operation, input: {}, bound: 5000 }));
		assert.deepEqual([ending.ending, ending.agpCode, ending.proxyCode], ["not-delivered", "NO_ROUTE", null], operation);
	}
	assert.deepEqual(asked, []);
	assert.equal(store.historyBound().answer.position, 0);
});

test("describe answers EM10's description: every operation ordered by name, its input the full shape document, answering whole", async (t) => {
	const { raw, server } = await setup(t);
	const ending = await within(raw.invoke({ host: "host-a", service: "store", operation: "describe", input: {}, bound: 5000 }));
	const expected = { service: "store", operations: ["create", "delete", "find", "history-bound", "read", "update"].map((name) => ({ name, input: EM10_SHAPES[name], answers: "whole" })) };
	assert.deepEqual(answerOf(ending), expected);
	assert.deepEqual(server.description(), expected, "the server's own description is the one served");
	assert.equal(server.service, "store");
});

test("no input shape admits a writer or a write identity: such an input is refused by operation-call as input-misfit before the writer naming, the policy or the store", async (t) => {
	const { raw, asked, store } = await setup(t);
	const inputs = [
		["create", { ...note("alpha"), writer: "mallory" }],
		["create", { ...note("alpha"), writeId: "1791540000000-0123456789abcdef" }],
		["update", { target: { id: "e1.1" }, name: "x", writer: "mallory" }],
		["delete", { target: { id: "e1.1" }, writer: "mallory" }],
		["update", { target: { id: "e1.1", writer: "mallory" }, name: "x" }],
	];
	for (const [operation, input] of inputs) {
		const ending = await within(raw.invoke({ host: "host-a", service: "store", operation, input, bound: 5000 }));
		assert.equal(ending.ending, "refused", JSON.stringify(input));
		assert.deepEqual([ending.refusal.part, ending.refusal.code], ["operation-call", "input-misfit"]);
		assert.ok(ending.refusal.misfits.some((m) => m.keyword === "additionalProperties"), "the misfit names the property not admitted");
	}
	assert.deepEqual(asked, [], "neither the writer naming nor the policy was asked");
	assert.equal(store.historyBound().answer.position, 0, "the store saw nothing");
});

test("two stores served under two names the application chooses, on one node, are each reached by their own name", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const first = openStore();
	const second = openStore();
	await serve(topology, { service: "notes", store: first.store });
	await serve(topology, { service: "drafts", store: second.store });
	answerOf(await within(clientOf(topology, "alice", { service: "notes" }).create(note("in-notes"))));
	answerOf(await within(clientOf(topology, "alice", { service: "drafts" }).create(note("in-drafts"))));
	assert.equal(first.store.read({ target: { kind: "note", name: "in-notes" } }).answer.entity.name, "in-notes");
	assert.equal(first.store.read({ target: { kind: "note", name: "in-drafts" } }).answer.entity, null);
	assert.equal(second.store.read({ target: { kind: "note", name: "in-drafts" } }).answer.entity.name, "in-drafts");
	assert.equal(second.store.read({ target: { kind: "note", name: "in-notes" } }).answer.entity, null);
});

test("a name breaking EM1's pattern is refused by operation-call's host, naming it, and nothing is exposed", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const { store } = openStore();
	for (const service of ["Store", "-store", "", "a".repeat(64), "store/x"]) {
		const serving = await serveStore({ node: topology.hostNodes.get("host-a"), service, store, nameWriter: () => "w", policy: () => ({ allowed: true }) });
		assert.equal(serving.served, false, JSON.stringify(service));
		assert.equal(serving.refusal.code, "invalid-name");
		assert.equal(serving.refusal.details.name, service);
	}
	assert.deepEqual(hostExports(topology), [], "no endpoint was exposed");
});

test("closing the server withdraws every endpoint, and a later call is not delivered", async (t) => {
	const { topology, server, client } = await setup(t);
	answerOf(await within(client.create(note("alpha"))));
	await server.close();
	for (const op of ["create", "update", "delete", "read", "find", "history-bound", "describe"]) await topology.hooks.gone("host-a", `store/${op}`);
	const ending = await within(client.read({ target: { id: "e1.1" } }));
	assert.deepEqual([ending.ending, ending.agpCode], ["not-delivered", "NO_ROUTE"]);
});

test("serving needs an open store, a writer naming and a policy: anything else is a programming error, thrown before anything is exposed", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const node = topology.hostNodes.get("host-a");
	const { store } = openStore();
	const good = { node, service: "store", store, nameWriter: () => "w", policy: () => ({ allowed: true }) };
	await assert.rejects(serveStore(null), TypeError);
	await assert.rejects(serveStore({ ...good, store: undefined }), TypeError);
	await assert.rejects(serveStore({ ...good, store: { read() {} } }), TypeError);
	await assert.rejects(serveStore({ ...good, nameWriter: "alice" }), TypeError);
	await assert.rejects(serveStore({ ...good, policy: undefined }), TypeError);
	await assert.rejects(serveStore({ ...good, evidence: "not a function" }), TypeError);
	assert.deepEqual(hostExports(topology), []);
});
