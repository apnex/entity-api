// topology - AGP nodes over AGP's production in-process carrier, @agp/transport-loopback, for entity-api's
// contract tests (zorg's Delta 1, verification targets): two host nodes that listen, `host-a` and `host-b`,
// and caller nodes, one per name, each dialling both hosts, each with its own operation-call caller. A
// caller node's name is its AGP node identifier, which the tests' evidence function reports, so a host's
// writer naming can name a writer from the request's evidence and from nothing else.
//
// Every node runs on one AGP injected clock (ManualClock); every caller's bound runs on one manual call
// clock, apart from AGP's, unless the topology is opened with the real call clock. Hooks: advance or move
// the call clock, hold a node's executor, lose a caller's channel to a host, make a caller's next send fail
// with an AGP code, record each call a caller is asked for, and wait until a host's endpoint is ready.
import { ManualClock } from "@agp/core";
import { createNode } from "@agp/node";
import { createLoopbackFabric } from "@agp/transport-loopback";
import { createCaller, systemCallClock } from "@apnex/operation-call";
import { createManualCallClock } from "./manual-call-clock.js";

const REPLY = "operation-call/replies";
const HOSTS = ["host-a", "host-b"];
let fabrics = 0;

/** A turn of the event loop. */
export const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Waits until a condition holds, failing after a bounded real time rather than hanging. */
export async function until(condition, what, ms = 60_000) {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		if (condition()) return;
		await turn();
	}
	throw new Error(`waited for ${what}, which never happened`);
}

/** Rejects when a promise has not settled within a real time, so a failing case fails rather than hangs. */
export function within(promise, what = "the ending", ms = 120_000) {
	let timer;
	const late = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not come within ${ms} ms`)), ms); });
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** An identity source of fresh identities that runs `hooks.attempt(n)` as a caller makes its nth attempt identity, while preparing its nth call. */
export function preparingIdentities() {
	let made = 0;
	let attempts = 0;
	const hooks = {};
	const source = {
		wallTimeMs: () => 1791540000000 + made,
		randomHex(digits) {
			made++;
			if (digits === 8) hooks.attempt?.(++attempts);
			return made.toString(16).padStart(digits, "0");
		},
	};
	return { hooks, source };
}

/**
 * Opens the topology. Options: callers, the names of the caller nodes made at once (more can be added);
 * realCallClock, to bound calls on operation-call's system call clock; identities, the identity source every
 * caller makes its invocation and attempt identities from; wrapHostNode(node), to give a host's
 * operations a wrapped node, as zorg's hub wraps its own node's send to drop answers in tests (RT9).
 */
export async function openTopology(options = {}) {
	const fabricId = `entity-api-${++fabrics}`;
	const fabric = createLoopbackFabric({ fabricId, limits: {
		maxTransports: 64, maxListeners: 8, maxPendingAcquisitions: 64, maxActiveChannels: 128, maxPacketBytes: 16_777_216,
		maxBufferedPacketsPerChannel: 1_024, maxBufferedBytesPerChannel: 67_108_864, maxQueuedPacketsTotal: 65_536,
		maxQueuedBytesTotal: 268_435_456, maxPendingSendBytesTotal: 17_179_869_184,
	} });
	const agpClock = new ManualClock();
	const manualClock = createManualCallClock();
	const callClock = options.realCallClock ? systemCallClock : manualClock;
	const channels = new Map();
	const port = (name, listen, targets) => {
		const scoped = fabric.createTransport({ transportName: name, capabilities: { listen, connect: targets.length > 0 } }).createPort({
			listeners: new Map(listen ? [["listen", { fabricId, address: name }]] : []),
			targets: new Map(targets.map((t) => [t, { fabricId, address: t }])),
		});
		return {
			resolveListener: (reference) => scoped.resolveListener(reference),
			resolveTarget(reference) {
				const target = scoped.resolveTarget(reference);
				if (target === undefined) return undefined;
				return { async connect(o, signal) { const channel = await target.connect(o, signal); channels.set(`${name}>${reference}`, channel); return channel; } };
			},
		};
	};
	const timers = { holdTimeMs: 0 };
	const hosts = new Map(HOSTS.map((id) => [id, createNode({
		nodeId: id, listen: { transportRef: "listen" }, capacity: { maxSessions: 32, maxPendingHandshakes: 32 }, timers, disposition: { debounceMs: 0 },
	}, { clock: agpClock, transport: port(id, true, []) })]));
	for (const node of hosts.values()) await node.start();
	const hostNodes = new Map([...hosts].map(([id, node]) => [id, options.wrapHostNode ? options.wrapHostNode(node, id) : node]));

	const callers = new Map();
	const holds = new Set();
	const established = (node, remote) => node.operations.connections().items.some((c) => c.remoteNodeId === remote && c.state === "Established");

	/** Adds a caller node named `name`, dialling both hosts, with a caller whose sends the hooks can see and fail. */
	const addCaller = async (name) => {
		if (callers.has(name)) return callers.get(name);
		const node = createNode({ nodeId: name, capacity: { maxSessions: 4, maxPendingHandshakes: 4 }, timers, disposition: { debounceMs: 0 }, peers: HOSTS.map((h) => ({
			adjacencyId: h, expectedNodeId: h, transportRef: h, reconnect: { initialDelayMs: 10, maximumDelayMs: 10 },
		})) }, { clock: agpClock, transport: port(name, false, HOSTS) });
		const calls = [];
		const endings = [];
		const failures = [];
		const sendingNode = {
			nodeId: node.nodeId,
			operations: node.operations,
			start: (...a) => node.start(...a),
			stop: (...a) => node.stop(...a),
			expose: (...a) => node.expose(...a),
			disposition: (...a) => node.disposition(...a),
			settled: (...a) => node.settled(...a),
			dispositions: (...a) => node.dispositions(...a),
			async send(...args) {
				const failure = failures.shift();
				if (failure !== undefined) throw Object.assign(new Error(`a send refused by the topology's hook, ${failure}`), { code: failure });
				return node.send(...args);
			},
		};
		await node.start();
		const caller = await createCaller({ node: sendingNode, clock: callClock, ...(options.identities ? { identities: options.identities } : {}) });
		// Every call the caller is asked for, as asked - what the client half gave the call layer - and its ending.
		const recorder = {
			invoke(call) { calls.push(call); const ending = caller.invoke(call); endings.push(ending); return ending; },
			newInvocation: () => caller.newInvocation(),
			discarded: () => caller.discarded(),
		};
		await until(() => HOSTS.every((h) => established(node, h)), `${name}'s sessions with both hosts`);
		const entry = { name, node, caller: recorder, calls, endings, failNextSend: (code) => failures.push(code) };
		callers.set(name, entry);
		return entry;
	};
	for (const name of options.callers ?? ["alice"]) await addCaller(name);

	const exportAcked = (node, endpoint, remote) => node.operations.routeExports().items.some((r) => r.endpoint === endpoint && r.remoteNodeId === remote && r.state === "acked");
	const routeVisible = (node, hostId, endpoint) => node.operations.routes().candidates.some((r) => r.endpoint === endpoint && r.originNodeId === hostId);

	const hooks = {
		advanceCallClock: (ms) => manualClock.advance(ms),
		moveCallClock: (ms) => manualClock.move(ms),
		advanceAgpClock: (ms) => agpClock.advanceBy(ms),
		/** Holds a node's executor until the returned release is called. */
		holdExecutor(nodeId) {
			const node = hosts.get(nodeId) ?? callers.get(nodeId)?.node;
			const blocker = Promise.withResolvers();
			holds.add(blocker);
			const blocked = node.executor.run(() => blocker.promise);
			return async () => { blocker.resolve(); await blocked; await node.executor.quiesce(); };
		},
		loseChannel(callerName, hostId) { channels.get(`${callerName}>${hostId}`).abort({ kind: "abort" }); },
		/** Waits until every caller can reach an endpoint on a host, and the host can answer each. */
		async ready(hostId, endpoint) {
			const host = hosts.get(hostId);
			const isReady = () => [...callers.values()].every(({ node, name }) => routeVisible(node, hostId, endpoint) && exportAcked(node, REPLY, hostId) && exportAcked(host, endpoint, name));
			const end = performance.now() + 60_000;
			while (!isReady()) {
				if (performance.now() > end) throw new Error(`${endpoint} on ${hostId} never became ready`);
				if (![...callers.values()].every(({ node }) => established(node, hostId))) agpClock.advanceBy(10);
				await turn();
			}
		},
		/** Advances AGP's clock a step at each turn until a call settles, as an admission deadline waits on it. */
		async settleOnAgpClock(promise, stepMs = 50) {
			let settled = false;
			promise.then(() => { settled = true; }, () => { settled = true; });
			await until(() => { if (!settled) agpClock.advanceBy(stepMs); return settled; }, "the call to settle as AGP's clock advanced");
			return promise;
		},
		/** Waits until no caller sees an endpoint on a host any longer. */
		async gone(hostId, endpoint) {
			await until(() => [...callers.values()].every(({ node }) => !routeVisible(node, hostId, endpoint)), `${endpoint} on ${hostId} withdrawn`);
		},
	};

	return {
		fabric, agpClock, callClock, manualClock, hosts, hostNodes, callers, hooks, addCaller,
		caller: (name) => callers.get(name),
		async close() {
			for (const blocker of holds) blocker.resolve();
			await Promise.allSettled([...[...callers.values()].map((c) => c.node.stop()), ...[...hosts.values()].map((n) => n.stop())]);
			await fabric.close(AbortSignal.timeout(5000));
		},
	};
}
