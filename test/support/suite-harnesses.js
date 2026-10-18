// suite-harnesses - the two harnesses entity-store's shared contract suite runs against in entity-api
// (zorg's Delta 1, E11; zorg's target, EM10): a store in this process, called directly; and the same store
// served by entity-api's host half and called through its client half, over AGP's production in-process
// carrier.
//
// In both, the writer recorded is the writer the host names. Locally the suite's writer is handed to the
// store as the writer named, as a host hands it. Remotely the suite's writer is the AGP node the call comes
// from: each writer calls through its own caller node, the host's evidence function reports the request's
// origin node, and the host's writer naming names that node - so the writer reaches the store from the
// request's evidence, never from its input. A remote write identity is the invocation identity: the suite's
// newWriteId gives a new invocation identity, and a write names it as its invocation, so the host reads it
// from operation-call's envelope (EM7).
import { systemCallClock } from "@apnex/operation-call";
import { createMemoryStoragePort, openEntityStore } from "@apnex/entity-store";
import { createStoreClient, serveStore } from "@apnex/entity-api";
import { openTopology } from "./topology.js";
import { nodeEvidence, nodeWriter } from "./serving.js";

const OPERATIONS = ["create", "update", "delete", "read", "find", "history-bound", "changes", "describe"];

/** Opens a store that must open over a port, with a clock the session sets. */
function opener(options, clock, storage) {
	return () => {
		const opening = openEntityStore({ ...options, storage, clock });
		if (!opening.opened) throw new Error(`the store did not open: ${JSON.stringify(opening.refusal)}`);
		return opening.store;
	};
}

/** The suite's harness for a store in this process, over memory storage, called directly. */
export function createLocalHarness({ writer = "alice" } = {}) {
	let ids = 0;
	return {
		async open(options, time) {
			let now = time;
			const open = opener(options, { now: () => now }, createMemoryStoragePort());
			let store = open();
			return {
				setTime(ms) { now = ms; },
				newWriteId() { return `local-write-${++ids}`; },
				async call(operation, input, caller = {}) {
					const write = { writer: caller.writer ?? writer, writeId: caller.writeId ?? `local-write-${++ids}` };
					switch (operation) {
						case "create": return store.create(input, write);
						case "update": return store.update(input, write);
						case "delete": return store.delete(input, write);
						case "read": return store.read(input);
						case "find": return store.find(input);
						case "history-bound": return store.historyBound();
						case "changes": return store.changes(input);
						default: throw new Error(`no operation ${operation}`);
					}
				},
				// Abandons the open store, as a killed process does, and opens another on the same storage.
				async restart() { store = open(); },
				async close() {},
			};
		},
	};
}

/**
 * The suite's harness for a store served by entity-api's host half on host-a and called through its client
 * half from caller nodes named for the writers. One topology serves every session; `close` ends it. Each
 * session serves its own store under its own name. `observe(event)` sees every call's operation, input and
 * ending, and every write the host's writer naming named, so a test can assert what crossed.
 */
export function createRemoteHarness({ writer = "alice", bound = 120_000, observe = () => {} } = {}) {
	let topology;
	let sessions = 0;
	const ready = async (service) => { for (const op of OPERATIONS) await topology.hooks.ready("host-a", `${service}/${op}`); };
	return {
		async close() { if (topology) await topology.close(); topology = undefined; },
		async open(options, time) {
			topology ??= await openTopology({ callers: [writer], realCallClock: true });
			const service = `suite-${++sessions}`;
			let now = time;
			const open = opener(options, { now: () => now }, createMemoryStoragePort());
			const nameWriter = (caller) => { const named = nodeWriter(caller); observe({ type: "writer", service, writer: named }); return named; };
			const serveOnce = async () => {
				const serving = await serveStore({ node: topology.hostNodes.get("host-a"), service, store: open(), nameWriter, policy: () => ({ allowed: true }), evidence: nodeEvidence });
				if (!serving.served) throw new Error(`not served: ${JSON.stringify(serving.refusal)}`);
				await ready(service);
				return serving.server;
			};
			let server = await serveOnce();
			const clients = new Map();
			const clientFor = async (name) => {
				if (!clients.has(name)) {
					const known = topology.callers.has(name);
					const entry = await topology.addCaller(name);
					if (!known) await ready(service);
					clients.set(name, { client: createStoreClient({ caller: entry.caller, host: "host-a", service, bound, clock: systemCallClock }), entry });
				}
				return clients.get(name);
			};
			const used = new Set();
			return {
				setTime(ms) { now = ms; },
				newWriteId() { return topology.caller(writer).caller.newInvocation(); },
				async call(operation, input, caller = {}) {
					const { client } = await clientFor(caller.writer ?? writer);
					let ending;
					if (operation === "create" || operation === "update" || operation === "delete") {
						const invocation = caller.writeId;
						const repeat = invocation !== undefined && used.has(invocation);
						if (invocation !== undefined) used.add(invocation);
						ending = await client[operation](input, { ...(invocation === undefined ? {} : { invocation }), repeat });
					} else if (operation === "read") ending = await client.read(input);
					else if (operation === "find") ending = await client.findPage(input);
					else if (operation === "history-bound") ending = await client.historyBound();
					else if (operation === "changes") ending = await client.changesPage(input);
					else throw new Error(`no operation ${operation}`);
					observe({ type: "call", service, operation, input, ending });
					if (ending.ending === "answered") return { outcome: "answered", answer: ending.answer };
					if (ending.ending === "refused") return { outcome: "refused", refusal: ending.refusal };
					throw new Error(`the remote ${operation} ended ${ending.ending}: ${JSON.stringify(ending)}`);
				},
				// The host's store is abandoned unclosed, as a killed process leaves it, its endpoints withdrawn, and
				// another store opened on the same storage is served under the same name.
				async restart() {
					await server.close();
					for (const op of OPERATIONS) await topology.hooks.gone("host-a", `${service}/${op}`);
					server = await serveOnce();
				},
				async close() {
					await server.close();
				},
			};
		},
	};
}
