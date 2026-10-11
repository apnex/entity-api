// shared-suite - entity-store's shared contract suite, run against a store called directly and against the
// same store served by entity-api's host half and called through its client half, with the writer named by
// the host in both (zorg's Delta 1, E11; zorg's target, EM8, EM9, EM10).
//
// Every case of every row entity-api carries from entity-store runs locally and remotely, none skipped; the
// storage-port row is entity-store's own and runs there, and the following rows are listed as deferred.
// Beside the suite: the same refusal locally and remotely for names of 63 and 64 characters, tags of 127 and
// 128, an unknown kind, a target of 200 characters, and a reused write identity with an over-long name, which
// identity-reused answers first (EM9); EM8's schedule of finds, run remotely by the suite's own case and
// checked here to be registered; and integers beyond the safe range and bodies of 4000 levels, refused
// remotely by operation-call as not-sendable, the integers refused locally by the store as unsafe-number (EM10).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { contractSuiteRows, registerEntityStoreSuite } from "@apnex/entity-store/contract-suite";
import { createLocalHarness, createRemoteHarness } from "../support/suite-harnesses.js";
import { T0, note } from "../support/serving.js";

const CARRIED = ["positioned-entity-write", "change-provenance", "expected-revision-write", "repeat-recognition", "identity-name-lookup", "find-by-kind-tags", "stated-history-bound", "store-refusal"];

const writes = [];
const calls = [];
const local = createLocalHarness();
const remote = createRemoteHarness({ observe: (event) => (event.type === "writer" ? writes : calls).push(event) });
let shared;
after(() => remote.close());
after(() => shared?.close());

const localNames = [];
const remoteNames = [];
const localCount = registerEntityStoreSuite((name, run) => { localNames.push(name); return test(`local: ${name}`, run); }, local);
const remoteCount = registerEntityStoreSuite((name, run) => { remoteNames.push(name); return test(`remote: ${name}`, run); }, remote);

test("the suite covers exactly the rows entity-api carries from entity-store, every case registered locally and remotely, none skipped", () => {
	assert.deepEqual([...contractSuiteRows.carried].sort(), [...CARRIED].sort());
	assert.ok(localCount > 50, `the suite registers its cases (${localCount})`);
	assert.equal(remoteCount, localCount);
	assert.deepEqual(remoteNames, localNames);
	for (const row of CARRIED) assert.ok(remoteNames.some((n) => n.startsWith(`${row}: `)), `${row} runs remotely`);
});

test("the storage-port row runs locally only, in entity-store, and the following rows are deferred under D15, as entity-api defers them", async () => {
	assert.ok(contractSuiteRows.localOnly.includes("storage-port"));
	assert.deepEqual({ ...contractSuiteRows.deferred }, { "changes-since-position": "D15", "follow-narrowed-set": "D15" });
});

test("EM8's schedule of finds - changes at 1000 and 1900, a bound of 1000, finds as of 0 and 1 at 2000 across a restart - is among the cases run remotely", () => {
	assert.ok(remoteNames.some((n) => n.startsWith("stated-history-bound: the schedule: changes at 1000 and 1900")));
	assert.ok(remoteNames.some((n) => n.startsWith("repeat-recognition: the schedule: changes at 1000 and 1900")));
});

test("remotely, every write the suite made had its writer named by the host from the request's evidence, and no input carried a writer", () => {
	const remoteWrites = calls.filter((c) => ["create", "update", "delete"].includes(c.operation));
	assert.ok(remoteWrites.length > 100, `the suite wrote remotely (${remoteWrites.length})`);
	assert.ok(writes.length >= remoteWrites.length, "the writer naming was asked for every write");
	for (const c of calls) assert.equal(JSON.stringify(c.input).includes("\"writer\""), false, "no input names a writer");
	assert.deepEqual([...new Set(writes.map((w) => w.writer))].sort(), ["alice", "bob", "carol", "carol-2"]);
});

const OPTIONS = { kinds: { note: { $schema: "urn:apnex:shape-check:dialect:1", type: "object", properties: { pointer: { type: "string", format: "uri" }, summary: { type: "string", minLength: 1 } }, required: ["pointer", "summary"], additionalProperties: false }, any: { $schema: "urn:apnex:shape-check:dialect:1" } }, historyMs: 60_000, maxEntityBytes: 65_536 };

/** Runs the same calls on a local and a remote session, giving both outcomes of each. */
async function bothWays(calls) {
	const results = [];
	for (const harness of [local, remote]) {
		const s = await harness.open(OPTIONS, T0);
		try {
			const outcomes = [];
			for (const [operation, input, caller] of calls) outcomes.push(await s.call(operation, input, typeof caller === "function" ? caller(s) : caller));
			results.push(outcomes);
		} finally {
			await s.close();
		}
	}
	return results;
}

test("EM9: the same refusal, unchanged, locally and remotely: names of 63 and 64, tags of 127 and 128, an unknown kind, a target of 200 characters, and a reused identity with an over-long name", async () => {
	const long = (n, c = "a") => c.repeat(n);
	let writeId;
	const remoteWriteIds = [];
	const reuse = () => ({ writeId });
	const calls = [
		["create", note(long(63)), {}],
		["create", note(long(64)), {}],
		["create", note("t127", [`${long(63)}:${long(63)}`]), {}],
		["create", note("t128", [`${long(64)}:${long(63)}`]), {}],
		["create", { kind: "unknown", name: "x", tags: [], body: 0 }, {}],
		["update", { target: { kind: "note", name: long(200) }, tags: [] }, {}],
		["read", { target: { kind: "note", name: long(200) } }, {}],
		["create", note("first"), (s) => { writeId = s.newWriteId(); if (!writeId.startsWith("local-")) remoteWriteIds.push(writeId); return { writeId }; }],
		["create", note(long(200)), reuse],
	];
	const [localOutcomes, remoteOutcomes] = await bothWays(calls);
	assert.deepEqual(localOutcomes.map((o) => o.outcome), ["answered", "refused", "answered", "refused", "refused", "refused", "answered", "answered", "refused"]);
	assert.deepEqual(localOutcomes.map((o) => o.refusal?.code ?? null), [null, "invalid-name", null, "invalid-tag", "unknown-kind", "not-found", null, null, "identity-reused"]);
	for (const [i, outcome] of remoteOutcomes.entries()) {
		if (outcome.outcome !== "refused") { assert.equal(localOutcomes[i].outcome, "answered"); continue; }
		// The one fact that differs is the write identity itself: locally the harness's, remotely the invocation identity.
		const expected = i === 8 ? { ...localOutcomes[i].refusal, details: { writeId: remoteWriteIds[0] } } : localOutcomes[i].refusal;
		assert.deepEqual(outcome.refusal, expected, `call ${i}: the remote refusal is the local one, unchanged`);
	}
	assert.match(remoteWriteIds[0], /^[0-9]{13}-[0-9a-f]{16}$/, "remotely the write identity is an invocation identity");
	assert.deepEqual(remoteOutcomes[5].refusal.details, { target: { kind: "note", name: long(128) }, truncated: true });
});

test("EM10: integers 9007199254740992 from zero, at the top of a body and nested in its objects and arrays, are refused locally as unsafe-number and remotely by operation-call as not-sendable", async () => {
	const bodies = [9007199254740992, -9007199254740992, { a: { b: 9007199254740992 } }, [0, [-9007199254740992]], { list: [{ n: 9007199254740992 }] }];
	const s = await local.open(OPTIONS, T0);
	for (const [i, body] of bodies.entries()) {
		const outcome = await s.call("create", { kind: "any", name: `n${i}`, tags: [], body });
		assert.equal(outcome.refusal.code, "unsafe-number", `body ${i} locally`);
	}
	await s.close();
	const { topology, client } = await remoteClient();
	const before = topology.calls.length;
	for (const [i, body] of bodies.entries()) {
		const ending = await client.create({ kind: "any", name: `n${i}`, tags: [], body });
		assert.equal(ending.ending, "refused", `body ${i} remotely`);
		assert.equal(ending.refusal.part, "operation-call");
		assert.equal(ending.refusal.code, "not-sendable");
	}
	assert.equal(topology.calls.length - before, bodies.length, "each was asked of the caller, which sent none");
	assert.equal(answer(await client.historyBound()).position, 0, "nothing was written");
});

test("EM10: bodies of 4000 nested arrays and of 4000 nested objects are refused remotely by operation-call as not-sendable, and nothing is written", async () => {
	let arrays = "core";
	let objects = "core";
	for (let i = 0; i < 4000; i++) { arrays = [arrays]; objects = { n: objects }; }
	const { client } = await remoteClient();
	for (const body of [arrays, objects]) {
		const ending = await client.create({ kind: "any", name: "deep", tags: [], body });
		assert.deepEqual([ending.ending, ending.refusal?.part, ending.refusal?.code], ["refused", "operation-call", "not-sendable"]);
	}
	assert.equal(answer(await client.historyBound()).position, 0);
});

/** A client of a fresh store served on its own topology, for cases that need the client half's endings whole. */
async function remoteClient() {
	const { openTopology } = await import("../support/topology.js");
	const { openStore, serve, clientOf } = await import("../support/serving.js");
	shared ??= await openTopology({ callers: ["alice"], realCallClock: true });
	const service = `limits-${Math.random().toString(16).slice(2, 10)}`;
	const { store } = openStore();
	await serve(shared, { service, store });
	return { topology: shared.caller("alice"), client: clientOf(shared, "alice", { service, bound: 120_000, clock: (await import("@apnex/operation-call")).systemCallClock }) };
}

const answer = (ending) => {
	assert.equal(ending.ending, "answered", JSON.stringify(ending));
	return ending.answer;
};
