// serving - a store served by entity-api's host half on a topology's host node, and clients of it, for the
// contract tests: a store over memory storage with a clock the test sets, the tests' evidence function -
// the request's origin node, as AGP's delivery context gives it - a writer naming that names that node, and
// a policy that allows everything unless a test gives its own.
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { createStoreClient, serveStore } from "@apnex/entity-api";
import { openTopology } from "./topology.js";

/** shape-check's dialect identifier (zorg's D19). */
export const SHAPE_DIALECT_ID = "urn:apnex:shape-check:dialect:1";

/** 2026-10-09T10:00:00.000Z. */
export const T0 = Date.UTC(2026, 9, 9, 10, 0, 0, 0);

/** The body shape of zorg's knowledge entry (EM4), as one ordinary kind. */
export const NOTE_SHAPE = {
	$schema: SHAPE_DIALECT_ID,
	type: "object",
	properties: { pointer: { type: "string", format: "uri", maxLength: 2048 }, summary: { type: "string", minLength: 1, maxLength: 1024 } },
	required: ["pointer", "summary"],
	additionalProperties: false,
};
export const KINDS = { note: NOTE_SHAPE, any: { $schema: SHAPE_DIALECT_ID } };

/** A note's create input. */
export const note = (name, tags = [], summary = `about ${name}`) => ({ kind: "note", name, tags, body: { pointer: `https://example.com/${name}`, summary } });

/** Opens a store that must open over a memory port, with a clock set through `setTime`. */
export function openStore({ time = T0, historyMs = 60_000, maxEntityBytes = 65_536, kinds = KINDS, storage = createMemoryStoragePort() } = {}) {
	let now = time;
	const opening = openEntityStore({ storage, clock: { now: () => now }, historyMs, maxEntityBytes, kinds });
	if (!opening.opened) throw new Error(`the store did not open: ${JSON.stringify(opening.refusal)}`);
	return { store: opening.store, storage, setTime: (ms) => { now = ms; }, now: () => now };
}

/** The tests' evidence function: who is calling, as AGP's delivery context says - the origin node. */
export const nodeEvidence = (delivery) => ({ kind: "test-node", node: delivery.source.originNodeId });
/** The tests' writer naming: the node the evidence names. */
export const nodeWriter = ({ evidence }) => evidence.node;
/** A policy that allows every operation. */
export const allowAll = () => ({ allowed: true });

/**
 * Serves a store on a host of the topology and waits until every caller can reach each operation. Options
 * are serveStore's, with the tests' evidence, writer naming and permissive policy by default.
 */
export async function serve(topology, { host = "host-a", service = "store", store, nameWriter = nodeWriter, policy = allowAll, evidence = nodeEvidence, wait = true } = {}) {
	const serving = await serveStore({ node: topology.hostNodes.get(host), service, store, nameWriter, policy, ...(evidence === null ? {} : { evidence }) });
	if (!serving.served) throw new Error(`the store was not served: ${JSON.stringify(serving.refusal)}`);
	if (wait) for (const op of ["create", "update", "delete", "read", "find", "history-bound", "changes", "describe"]) await topology.hooks.ready(host, `${service}/${op}`);
	return serving.server;
}

/** A client, through the named caller node, of the store served under `service` on `host`. */
export function clientOf(topology, name, { host = "host-a", service = "store", bound = 10_000, clock, identities } = {}) {
	return createStoreClient({ caller: topology.caller(name).caller, host, service, bound, clock: clock ?? topology.callClock, ...(identities ? { identities } : {}) });
}

/**
 * A call request as the call layer reads it: each field of CallRequest the request gives a value, read once
 * here - a single call's option getters give the value they first read at every read (EM10, D55).
 */
export function requested(call) {
	const fields = {};
	for (const name of ["host", "service", "operation", "input", "bound", "invocation", "repeat", "signal"]) {
		const value = call[name];
		if (value !== undefined) fields[name] = value;
	}
	return fields;
}

/** The answer of an ending that must be answered. */
export function answerOf(ending, what = "the call") {
	if (ending.ending !== "answered") throw new Error(`${what}: expected an answer, got ${JSON.stringify(ending)}`);
	return ending.answer;
}

/**
 * A topology with a store served on host-a and a client per caller node, closed when the test ends. Options:
 * callers; store, the store's options; bound, each client's default bound; the rest are serve's.
 */
export async function served(t, { callers = ["alice", "bob"], store: storeOptions = {}, bound = 10_000, ...serveOptions } = {}) {
	const topology = await openTopology({ callers });
	t.after(() => topology.close());
	const opened = openStore(storeOptions);
	const server = await serve(topology, { store: opened.store, ...serveOptions });
	const clients = Object.fromEntries(callers.map((c) => [c, clientOf(topology, c, { bound })]));
	return { topology, server, clients, ...opened };
}
