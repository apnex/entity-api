// follow-closes-with-call - a remote follow ends only when the call carrying it ends - a caller ends it by
// cancelling that call - and the watcher resumes from its own position (zorg's target, EM18; zorg's D4, D6;
// Delta 4's D4-E7).
//
// A store served on host-a and followed through the client half over AGP's production in-process carrier, the
// host's liveness and alive on a controlled clock it is given through serveStore's `clock`: cancelling, answered
// with the last part's `through` or with `since`, the host's operation returned, its wait gone and its follow
// released; a cancel while an item's, and a checkpoint's, admission is held, nothing more asked meanwhile; a quiet
// follow kept alive by alive past several bounds; the host's liveness lapsing, the call's bound passing and the
// node stopping, each releasing the follow; a follow already cancelled as it starts; refusals in the order policy,
// store, too-many-follows; maxFollows, its range and its release by every way a follow ends, failures ending
// exactly and a store's failure deciding over a cancel that came meanwhile; resuming from the last through, after a
// whole change and within a change of two writes; a part AGP refuses; a request accepting no parts; and the
// client's `follow`, through a caller of the test's own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStoragePort } from "@apnex/entity-store";
import { createStoreClient, serveStore } from "@apnex/entity-api";
import { readCallRequest } from "@apnex/operation-call";
import { createManualCallClock } from "../support/manual-call-clock.js";
import { openTopology, until, within } from "../support/topology.js";
import { clientOf, nodeEvidence, note, openStore, serve, T0 } from "../support/serving.js";
import { policyRefusal } from "../support/policies.js";

const iso = (ms) => new Date(ms).toISOString();
let seeds = 0;
const seed = (store, input) => store.create(input, { writer: "seed", writeId: `seed-${++seeds}` }).answer;

/**
 * A store wrapped so a test sees, and may change, each page the host asks for and each wait it begins; a wait
 * notes how it settled, and `onWait` may give one of its own, being given the host's signal.
 */
function watchedStore(store, { onFollow, onWait } = {}) {
	const log = [];
	const pages = [];
	const waits = [];
	let asked = 0;
	const methods = ["create", "update", "delete", "read", "find", "historyBound", "changes", "checkRepeat"];
	const wrapper = Object.fromEntries(methods.map((m) => [m, (...args) => store[m](...args)]));
	wrapper.follow = (input) => {
		log.push("follow");
		const n = ++asked;
		const page = onFollow?.(input, n) ?? store.follow(input);
		pages.push({ input, page });
		return page;
	};
	wrapper.waitForChange = (after, options) => {
		log.push("wait");
		const waiting = onWait?.(after, options, waits.length + 1) ?? store.waitForChange(after, options);
		const entry = { after, signal: options?.signal, settled: false, outcome: undefined };
		waits.push(entry);
		waiting.then((v) => { entry.settled = true; entry.outcome = v; }, (e) => { entry.settled = true; entry.outcome = e; });
		return waiting;
	};
	return { store: wrapper, log, pages, waits };
}

/**
 * A host node whose sends of `part` messages a test may hold - `gate.hold = true` - each then waiting until the
 * test admits or refuses it; `gate.pending` lists them, and `gate.refuseNext` refuses the next part with a code.
 * With `gate.deliverThenHold`, a part is delivered at once but its admission given to the host only when the test
 * releases it. `gate.parts` counts the parts the host submitted, and `gate.cancels` the cancels that reached it.
 */
function gatedNode(node, gate) {
	gate.parts ??= 0;
	gate.cancels ??= 0;
	return new Proxy(node, {
		get(target, prop) {
			if (prop === "expose") {
				return (endpoint, handler) => target.expose(endpoint, (payload, context) => {
					if (payload?.type === "cancel") gate.cancels++;
					return handler(payload, context);
				});
			}
			if (prop === "send" || prop === "sendDirectPeer") {
				return (source, destination, payload, options) => {
					if (payload?.type === "part") {
						gate.parts++;
						if (gate.deliverThenHold) {
							const sent = target[prop](source, destination, payload, options);
							return new Promise((resolve, reject) => {
								gate.pending.push({ payload, admit: () => sent.then(resolve, reject), refuse: (code) => reject(Object.assign(new Error(`refused by the test, ${code}`), { code })) });
							});
						}
						if (gate.refuseNext !== undefined) {
							const code = gate.refuseNext;
							gate.refuseNext = undefined;
							return Promise.reject(Object.assign(new Error(`refused by the test, ${code}`), { code }));
						}
						if (gate.hold) {
							return new Promise((resolve, reject) => {
								gate.pending.push({
									payload,
									admit: () => target[prop](source, destination, payload, options).then(resolve, reject),
									refuse: (code) => reject(Object.assign(new Error(`refused by the test, ${code}`), { code })),
								});
							});
						}
					}
					return target[prop](source, destination, payload, options);
				};
			}
			const value = target[prop];
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** A topology with a store served on host-a; the host keeps time on `hostClock`, the topology's call clock by default. */
async function setup(t, { storeOptions = {}, wrap, gate, hostClock, bound = 1000, callers = ["alice"], ...serveOptions } = {}) {
	const topology = await openTopology({ callers, ...(gate ? { wrapHostNode: (node) => gatedNode(node, gate) } : {}) });
	t.after(() => topology.close());
	const opened = openStore({ maxEntityBytes: 262_144, ...storeOptions });
	const watched = watchedStore(opened.store, wrap);
	const server = await serve(topology, { store: watched.store, clock: hostClock ?? topology.callClock, ...serveOptions });
	return { topology, server, raw: opened.store, setTime: opened.setTime, ...watched, served: watched.store, client: clientOf(topology, "alice", { bound }) };
}

/** Starts a follow collecting every part's answer; `stop()` cancels it and gives its ending. */
function follow(client, input, { onPart } = {}) {
	const parts = [];
	const controller = new AbortController();
	const ending = client.follow(input, { signal: controller.signal, onPart: (part) => { parts.push(part); return onPart?.(part); } });
	return { parts, ending, controller, stop: async () => { controller.abort(); return within(ending); } };
}

/** Advances the call clock in steps, letting AGP carry what each step started, as time passing does. */
async function pass(topology, ms, by = 50, clock = topology.manualClock) {
	for (let left = ms; left > 0; left -= by) {
		clock.advance(Math.min(by, left));
		for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	}
}

/** Gives a follow `name` the chance to be admitted: true when it holds, false when refused too-many-follows. */
async function admitted(s, input = { kind: "note", since: 0 }) {
	const f = follow(s.client, input);
	const waits = s.waits.length;
	const outcome = await Promise.race([f.ending.then((e) => e), until(() => s.waits.length > waits, "a wait", 30_000).then(() => "waiting")]);
	if (outcome === "waiting") {
		await f.stop();
		return true;
	}
	assert.deepEqual([outcome.ending, outcome.refusal?.code], ["refused", "too-many-follows"], `refused too-many-follows, not ${JSON.stringify(outcome)}`);
	return false;
}

// Cancelling (D4, EM18).

test("cancelling ends the call answered with the last part's through, and with since when cancelled before any part; the host's operation returns, its wait gone and its listener removed, and its follow released", async (t) => {
	const s = await setup(t, { maxFollows: 1 });
	seed(s.raw, note("alpha", ["set:yes"]));
	seed(s.raw, note("beta", ["set:no"]));
	const f = follow(s.client, { kind: "note", tags: ["set:yes"], since: 0 });
	await until(() => s.waits.length === 1, "the host waiting");
	assert.deepEqual(f.parts.map((p) => [p.through, p.change === null]), [[1, false], [2, true]]);
	const ending = await f.stop();
	assert.deepEqual([ending.ending, ending.answer], ["answered", { position: 2 }], "the last part's through");
	assert.ok(s.waits[0].settled && s.waits[0].outcome === s.waits[0].signal.reason, "the host's wait rejected with its signal's reason");
	const early = follow(s.client, { kind: "note", tags: ["set:yes"], since: 2 });
	await until(() => s.waits.length === 2, "the second follow held: the first was released");
	const second = await early.stop();
	assert.deepEqual([second.ending, second.answer, early.parts], ["answered", { position: 2 }, []], "cancelled before any part: since");
});

test("a cancel while an item's admission is held: nothing more is asked meanwhile; admitted, it ends answered counting the item, and refused, the host's end is failed and the call unknown with answer-not-sendable", async (t) => {
	for (const settle of ["admit", "refuse"]) {
		const gate = { hold: true, pending: [] };
		const s = await setup(t, { gate });
		seed(s.raw, note("alpha", ["set:yes"]));
		seed(s.raw, note("beta", ["set:yes"]));
		const f = follow(s.client, { kind: "note", tags: ["set:yes"], since: 0 });
		await until(() => gate.pending.length === 1, `${settle}: the first part held`);
		const log = s.log.length;
		f.controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(gate.pending.length, 1, `${settle}: one part only waits; no second is submitted while the first is held`);
		assert.equal(s.log.length, log, `${settle}: no page asked and no wait begun while it is held`);
		gate.hold = false;
		if (settle === "admit") gate.pending[0].admit();
		else gate.pending[0].refuse("MESSAGE_TOO_LARGE");
		const ending = await within(f.ending);
		if (settle === "admit") {
			assert.deepEqual([ending.ending, ending.answer], ["answered", { position: 1 }], "admitted: its through counted, and no later part");
			assert.deepEqual(f.parts.map((p) => p.through), [1]);
		} else {
			assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "answer-not-sendable", "MESSAGE_TOO_LARGE"], "refused: the host's failed end, unknown at the caller");
		}
		assert.equal(s.log.length, log, `${settle}: nothing asked of the store after it`);
	}
});

test("a cancel while a checkpoint's admission is held: one part only submitted and no page asked or wait begun meanwhile; admitted, it ends answered counting it, and refused, the host's end is failed and the call unknown with answer-not-sendable", async (t) => {
	for (const settle of ["admit", "refuse"]) {
		const gate = { hold: true, pending: [] };
		const s = await setup(t, { gate });
		seed(s.raw, note("outside", ["set:no"]));
		const f = follow(s.client, { kind: "note", tags: ["set:yes"], since: 0 });
		await until(() => gate.pending.length === 1, `${settle}: the checkpoint held`);
		assert.equal(gate.pending[0].payload.answer.change, null);
		f.controller.abort();
		await until(() => gate.cancels === 1, `${settle}: the cancel reached the host`);
		assert.deepEqual([gate.parts, s.pages.length, s.waits.length], [1, 1, 0], `${settle}: one part submitted, one page asked, no wait begun while it is held`);
		gate.hold = false;
		if (settle === "admit") gate.pending[0].admit();
		else gate.pending[0].refuse("MESSAGE_TOO_LARGE");
		const ending = await within(f.ending);
		if (settle === "admit") assert.deepEqual([ending.ending, ending.answer, f.parts], ["answered", { position: 1 }, [{ through: 1, change: null }]]);
		else assert.deepEqual([ending.ending, ending.reason, ending.agpCode, f.parts], ["unknown", "answer-not-sendable", "MESSAGE_TOO_LARGE", []]);
		assert.deepEqual([gate.parts, s.pages.length, s.waits.length], [1, 1, 0], `${settle}: nothing more after it`);
	}
});

// The follow's life (EM11, EM18).

test("a quiet follow is kept alive by alive past several bounds, both sides on the controlled clock", async (t) => {
	const s = await setup(t, { bound: 1000 });
	const f = follow(s.client, { kind: "note", since: 0 });
	await until(() => s.waits.length === 1, "the host waiting");
	await pass(s.topology, 5000);
	assert.equal(await Promise.race([f.ending.then(() => "ended"), new Promise((r) => setTimeout(() => r("going"), 50))]), "going", "after five bounds the follow goes on");
	assert.deepEqual((await f.stop()).answer, { position: 0 });
});

test("the host's liveness of a caller that has gone lapses at twice aliveWithinMs and releases the follow", async (t) => {
	const hostClock = createManualCallClock();
	const s = await setup(t, { bound: 1000, hostClock, maxFollows: 1 });
	const f = follow(s.client, { kind: "note", since: 0 });
	await until(() => s.waits.length === 1, "the host waiting");
	// The caller's clock stands still, so it sends no alive; the host's runs to twice aliveWithinMs, 1000.
	await pass(s.topology, 999, 333, hostClock);
	assert.equal(s.waits[0].settled, false, "at 999 the follow is held");
	await pass(s.topology, 1, 1, hostClock);
	await until(() => s.waits[0].settled, "the host's signal fired at 1000");
	const ending = await within(f.ending);
	assert.deepEqual([ending.ending, ending.answer], ["answered", { position: 0 }]);
	assert.ok(await admitted(s), "the follow was released");
});

test("the call's bound passing with the host quiet sends a cancel that releases the follow", async (t) => {
	const hostClock = createManualCallClock();
	const s = await setup(t, { bound: 1000, hostClock, maxFollows: 1 });
	const f = follow(s.client, { kind: "note", since: 0 });
	await until(() => s.waits.length === 1, "the host waiting");
	// The host's clock stands still, so it sends no alive; the caller's runs past its bound.
	await pass(s.topology, 1000);
	const ending = await within(f.ending);
	assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"]);
	await until(() => s.waits[0].settled, "the cancel reached the host");
	assert.ok(await admitted(s), "the follow was released");
});

test("the node stopping fires the host's signal: its wait ends and the follow returns", async (t) => {
	const s = await setup(t);
	follow(s.client, { kind: "note", since: 0 });
	await until(() => s.waits.length === 1, "the host waiting");
	await s.topology.hosts.get("host-a").stop();
	await until(() => s.waits[0].settled, "the wait ended as the node stopped");
	assert.equal(s.waits[0].outcome, s.waits[0].signal.reason, "rejected with the host's signal's reason");
});

test("a follow already cancelled as its operation starts is answered by its checks: allowed, answered with since and no part; refused by the policy, refused", async (t) => {
	for (const allowed of [true, false]) {
		let release;
		const held = new Promise((resolve) => { release = resolve; });
		let asked = 0;
		const evidence = (delivery) => (delivery.destination === "store/follow" ? (asked++, held.then(() => nodeEvidence(delivery))) : nodeEvidence(delivery));
		const refusal = policyRefusal("invalid-identity", {});
		const s = await setup(t, { evidence, policy: (q) => (q.operation === "follow" && !allowed ? { allowed: false, refusal } : { allowed: true }) });
		seed(s.raw, note("alpha", ["set:yes"]));
		const f = follow(s.client, { kind: "note", since: 0 });
		await until(() => asked === 1, "the evidence port asked, and held");
		f.controller.abort();
		await new Promise((resolve) => setTimeout(resolve, 100));
		release();
		const ending = await within(f.ending);
		if (allowed) assert.deepEqual([ending.ending, ending.answer, f.parts], ["answered", { position: 0 }, []], "answered with since, no part sent");
		else assert.deepEqual([ending.ending, ending.refusal], ["refused", refusal], "the policy's refusal");
	}
});

// Refusals and maxFollows (EM9, EM18).

test("refusals come in the order policy, store, too-many-follows; the policy is asked the whole question, and nothing of the store after it refuses", async (t) => {
	const questions = [];
	const refusal = policyRefusal("invalid-identity", {});
	let refuse = false;
	const s = await setup(t, { maxFollows: 1, policy: (q) => { questions.push(q); return refuse ? { allowed: false, refusal } : { allowed: true }; } });
	const holding = follow(s.client, { kind: "note", since: 0 });
	await until(() => s.waits.length === 1, "one follow held");
	const input = { kind: "nothing", tags: ["a:b"], since: -1 };
	refuse = true;
	const log = s.log.length;
	const byPolicy = await within(s.client.follow(input, { onPart: () => undefined }));
	assert.deepEqual([byPolicy.ending, byPolicy.refusal], ["refused", refusal], "the policy's refusal first");
	assert.equal(s.log.length, log, "nothing asked of the store");
	const q = questions.at(-1);
	assert.deepEqual([q.operation, q.input, q.evidence, q.writer, q.target, q.repeat], ["follow", input, { kind: "test-node", node: "alice" }, null, null, false], "the whole question");
	assert.equal(q.delivery.destination, "store/follow");
	refuse = false;
	const byStore = await within(s.client.follow(input, { onPart: () => undefined }));
	assert.deepEqual([byStore.ending, byStore.refusal.code], ["refused", "unknown-kind"], "then the store's, though the host is full");
	const full = await within(s.client.follow({ kind: "note", since: 0 }, { onPart: () => undefined }));
	assert.deepEqual([full.ending, full.refusal], ["refused", {
		part: "entity-api", code: "too-many-follows", what: full.refusal.what, why: full.refusal.why, fix: full.refusal.fix, details: { limit: 1 },
	}], "then too-many-follows, with exactly limit");
	for (const field of ["what", "why", "fix"]) assert.ok(full.refusal[field].length > 0);
	await holding.stop();
});

test("maxFollows: the default of 16 refuses the seventeenth follow and admits one again once a follow ends; 1024 is accepted; any other value throws a RangeError", async (t) => {
	const s = await setup(t, { callers: ["alice"] });
	const held = [];
	for (let i = 0; i < 16; i++) {
		held.push(follow(s.client, { kind: "note", since: 0 }));
		await until(() => s.waits.length === i + 1, `follow ${i + 1} held`);
	}
	assert.equal(await admitted(s), false, "the seventeenth refused");
	await held[0].stop();
	assert.equal(await admitted(s), true, "admitted again once one ended");
	for (const f of held.slice(1)) await f.stop();
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const { store } = openStore();
	const base = { node: topology.hostNodes.get("host-a"), store, nameWriter: () => "w", policy: () => ({ allowed: true }) };
	const ok = await serveStore({ ...base, service: "wide", maxFollows: 1024 });
	assert.equal(ok.served, true, "1024 accepted");
	await ok.server.close();
	for (const maxFollows of [0, 1025, 1.5, null, "16", Number.NaN]) {
		await assert.rejects(serveStore({ ...base, service: "bad", maxFollows }), RangeError, `maxFollows ${String(maxFollows)}`);
	}
});

test("a follow is released however it ends: by a later page refused, by a store whose follow throws, and by a wait rejected with store-stopped, each ending exactly", async (t) => {
	const stopped = () => Object.assign(new Error("entity-store stopped"), { code: "store-stopped" });
	const refusal = { part: "entity-store", code: "position-not-held", what: "w", why: "y", fix: "f", details: { position: 0 } };
	const ways = {
		"a later page refused": [{ onFollow: (_i, n) => (n === 2 ? { outcome: "refused", refusal } : undefined) }, (e) => assert.deepEqual([e.ending, e.refusal], ["refused", refusal])],
		"a store whose follow throws": [{ onFollow: (_i, n) => { if (n === 2) throw stopped(); return undefined; } }, (e) => assert.deepEqual([e.ending, e.reason], ["unknown", "operation-failed"])],
		"a wait rejected with store-stopped": [{ onWait: (_a, _o, n) => (n === 1 ? Promise.reject(stopped()) : undefined) }, (e) => assert.deepEqual([e.ending, e.reason], ["unknown", "operation-failed"])],
	};
	for (const [how, [wrap, check]] of Object.entries(ways)) {
		const s = await setup(t, { maxFollows: 1, wrap });
		const f = follow(s.client, { kind: "note", since: 0 });
		if (how !== "a wait rejected with store-stopped") {
			await until(() => s.waits.length === 1, `${how}: the host waiting`);
			seed(s.raw, note("alpha"));
		}
		check(await within(f.ending));
		assert.ok(await admitted(s), `${how}: released`);
	}
});

test("a wait the store rejects with store-stopped though a cancel fired the signal meanwhile ends the call failed; one the signal rejected stays answered though the store then stops", async (t) => {
	const stopped = Object.assign(new Error("entity-store stopped"), { code: "store-stopped" });
	// The store's rejection is settled as the signal fires, before the host's continuation runs.
	const first = await setup(t, { wrap: { onWait: (_a, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(stopped), { once: true })) } });
	const failing = follow(first.client, { kind: "note", since: 0 });
	await until(() => first.waits.length === 1, "the host waiting");
	const ending = await failing.stop();
	assert.deepEqual([ending.ending, ending.reason], ["unknown", "operation-failed"], "the store's failure decides");
	// The signal rejects the wait, and the store then stops before the host's continuation runs.
	let stoppedStore = false;
	const second = await setup(t, { wrap: {
		onFollow: (_i, n) => { if (n > 1 && stoppedStore) throw stopped; return undefined; },
		onWait: (_a, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { reject(options.signal.reason); stoppedStore = true; }, { once: true })),
	} });
	const cancelled = follow(second.client, { kind: "note", since: 0 });
	await until(() => second.waits.length === 1, "the host waiting");
	const answered = await cancelled.stop();
	assert.ok(stoppedStore, "the store had stopped before the host's continuation ran");
	assert.deepEqual([answered.ending, answered.answer], ["answered", { position: 0 }], "the cancel decides; the store is not asked again");
	assert.equal(second.pages.length, 1, "no page asked after the wait");
});

// Resuming (D6, EM18).

/**
 * Follows with each part delivered but its admission held, cancelling once `stopAt` parts have arrived and the
 * cancel has reached the host, then releasing the admission: the call ends with exactly those parts taken.
 */
async function stoppedAt(s, gate, input, stopAt) {
	const f = follow(s.client, input);
	for (let n = 1; n <= stopAt; n++) {
		await until(() => f.parts.length === n && gate.pending.length === n, `part ${n} delivered, its admission held`);
		if (n < stopAt) gate.pending[n - 1].admit();
	}
	f.controller.abort();
	await until(() => gate.cancels === 1, "the cancel reached the host");
	assert.equal(gate.parts, stopAt, "no part submitted after the held one");
	gate.deliverThenHold = false;
	gate.pending[stopAt - 1].admit();
	const ending = await within(f.ending);
	assert.equal(f.parts.length, stopAt, "the call stopped with exactly those parts taken");
	assert.equal(s.waits.length, 0, "it never reached the end of what the store held");
	return { parts: f.parts, ending };
}

test("a follow cancelled after a whole change and resumed from its last through misses and repeats no item", async (t) => {
	const gate = { deliverThenHold: true, pending: [] };
	const s = await setup(t, { gate });
	for (const name of ["a", "b", "c", "d"]) seed(s.raw, note(name, ["set:yes"]));
	const first = await stoppedAt(s, gate, { kind: "note", tags: ["set:yes"], since: 0 }, 2);
	assert.deepEqual(first.ending.answer, { position: 2 }, "answered with the last part's through, after the change at 2");
	const second = follow(s.client, { kind: "note", tags: ["set:yes"], since: first.parts.at(-1).through });
	await until(() => s.waits.length === 1, "the resumed follow waiting");
	await second.stop();
	assert.deepEqual([...first.parts, ...second.parts].map((p) => p.change.entity.name), ["a", "b", "c", "d"], "every item once, in order");
});

test("a change of two writes, recovered from a log, cancelled between its items and resumed from the last through, gives its first item again and loses neither", async (t) => {
	const storage = createMemoryStoragePort();
	const at = iso(T0);
	const env = (id, name, position, created) => ({ id, kind: "note", name, tags: ["set:yes"], body: { pointer: `https://example.com/${name}`, summary: `about ${name}` }, revision: 1, created: { position: created, at, writer: "fixture" }, changed: { position, at, writer: "fixture" } });
	const left = env("e1.1", "left", 1, 1);
	const right = env("e1.2", "right", 1, 1);
	storage.append({ type: "change", position: 1, at, writer: "fixture", writeId: "f1", digest: "0".repeat(64), answer: { position: 1, entity: left }, writes: [{ operation: "create", id: "e1.1", entity: left }, { operation: "create", id: "e1.2", entity: right }] });
	const gate = { deliverThenHold: true, pending: [] };
	const s = await setup(t, { storeOptions: { storage }, gate });
	const first = await stoppedAt(s, gate, { kind: "note", since: 0 }, 1);
	assert.deepEqual([first.parts[0].through, first.ending.answer], [0, { position: 0 }], "cancelled after the first item, whose through is one less than its change's position");
	const second = follow(s.client, { kind: "note", since: first.parts[0].through });
	await until(() => s.waits.length === 1, "the resumed follow waiting");
	await second.stop();
	assert.deepEqual([...first.parts, ...second.parts].map((p) => p.change.entity.name), ["left", "left", "right"], "the first item given again, neither lost");
});

// Parts AGP refuses and callers accepting none (EM11, EM18).

test("a part AGP refuses ends the invocation failed at the host and the call unknown with answer-not-sendable and AGP's code, and releases the follow", async (t) => {
	const gate = { hold: false, pending: [], refuseNext: "MESSAGE_TOO_LARGE" };
	const s = await setup(t, { gate, maxFollows: 1 });
	seed(s.raw, note("alpha"));
	const ending = await within(s.client.follow({ kind: "note", since: 0 }, { onPart: () => undefined }));
	assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "answer-not-sendable", "MESSAGE_TOO_LARGE"]);
	assert.ok(await admitted(s, { kind: "note", since: 1 }), "released");
});

test("a request accepting no parts has no liveness at the host: it is held until its caller cancels it, then released", async (t) => {
	const s = await setup(t, { maxFollows: 1 });
	const controller = new AbortController();
	const raw = s.topology.caller("alice").caller;
	const whole = raw.invoke({ host: "host-a", service: "store", operation: "follow", input: { kind: "note", since: 0 }, bound: 100_000, signal: controller.signal });
	await until(() => s.waits.length === 1, "the follow held");
	await pass(s.topology, 10_000, 500);
	assert.equal(s.waits[0].settled, false, "held, with no liveness, as its clock runs");
	assert.equal(await admitted(s), false, "and holding the only follow");
	controller.abort();
	const ending = await within(whole);
	assert.deepEqual([ending.ending, ending.answer], ["answered", { position: 0 }], "cancelled, answered");
	assert.ok(await admitted(s), "released");
});

// The client's follow (EM10, EM12, EM18).

test("the client's follow is a single call: each option read once after the caller reads its clock, onPart absent or not a function thrown with nothing sent, each part's answer given to onPart at once and its return given back, and the caller's ending unchanged, a hop's included", async () => {
	const ID = "1791540000000-0123456789abcdef";
	const log = [];
	const returned = [];
	let reply;
	const caller = {
		async invoke(request) {
			log.push("clock");
			const read = readCallRequest(request);
			log.push("read");
			assert.equal(request.onPart, read.onPart, "onPart read again gives the function first read");
			for (const [sequence, answer] of [[1, { through: 1, change: { id: "e1.1" } }], [2, { through: 2, change: null }]]) {
				const part = Object.freeze({ sequence, answer: Object.freeze(answer) });
				log.push(`part ${sequence}`);
				returned.push(read.onPart(part));
				log.push(`given ${sequence}`);
			}
			return reply(read);
		},
	};
	const client = createStoreClient({ caller, host: "host-a", service: "store", bound: 777, clock: { now() { throw new Error("a follow reads no clock of entity-api's"); } } });
	const signal = new AbortController().signal;
	const marker = Promise.reject(new Error("onPart's own rejection, given back"));
	marker.catch(() => undefined);
	const given = [];
	const options = () => ({
		get bound() { log.push("bound"); return 1234; },
		get invocation() { log.push("invocation"); return ID; },
		get signal() { log.push("signal"); return signal; },
		get onPart() { log.push("onPart"); return (answer) => { given.push(answer); log.push(`onPart ${answer.through}`); return marker; }; },
	});
	const endings = [
		{ ending: "answered", invocation: ID, attempt: `${ID}.00000001`, operation: "follow", answer: { position: 2 } },
		{ ending: "unknown", invocation: ID, attempt: null, operation: "follow", reason: "hop-stalled", agpCode: null, deliveryReport: null },
		{ ending: "not-delivered", invocation: ID, attempt: null, operation: "follow", agpCode: null, proxyCode: "proxy-unreachable", earlierAttemptsUncertain: false },
	];
	for (const expected of endings) {
		log.length = 0;
		given.length = 0;
		returned.length = 0;
		reply = (read) => Object.freeze({ ...expected, bound: read.bound });
		const ending = await client.follow({ kind: "note", since: 0 }, options());
		assert.deepEqual(log, ["clock", "bound", "invocation", "signal", "onPart", "read", "part 1", "onPart 1", "given 1", "part 2", "onPart 2", "given 2"], "options read once after the caller's clock; each answer given at once, synchronously");
		assert.deepEqual(ending, { ...expected, bound: 1234 }, `${expected.ending}: the caller's ending, unchanged`);
		assert.deepEqual(given, [{ through: 1, change: { id: "e1.1" } }, { through: 2, change: null }], "each part's answer");
		assert.ok(given.every((a) => Object.isFrozen(a)), "frozen as the call layer gave it");
		assert.deepEqual(returned, [marker, marker], "what onPart returns is given back to the call layer");
	}
	reply = (read) => Object.freeze({ ...endings[0], bound: read.bound });
	assert.equal((await client.follow({ kind: "note", since: 0 }, { onPart: () => undefined })).bound, 777, "the client's bound by default");
	let sent = 0;
	const counting = { invoke(request) { sent++; return Promise.resolve().then(() => readCallRequest(request)); } };
	const strict = createStoreClient({ caller: counting, host: "host-a", service: "store", bound: 777 });
	for (const [what, o] of [["onPart absent", {}], ["onPart null", { onPart: null }], ["onPart a string", { onPart: "f" }], ["no options", undefined], ["options a string", "fast"]]) {
		await assert.rejects(strict.follow({ kind: "note", since: 0 }, o), TypeError, `${what}: a programming error`);
	}
	assert.equal(sent, 5, "each reached the caller, which threw as it read the request, sending nothing");
});

test("through operation-call's caller, an onPart that throws, returns a rejected promise or returns one that never settles changes nothing: every part is given, the ending stands, and no rejection is left unhandled", async (t) => {
	const s = await setup(t);
	for (const name of ["a", "b"]) seed(s.raw, note(name));
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	for (const [what, onPart] of [["throws", () => { throw new Error("onPart throws"); }], ["rejects", () => Promise.reject(new Error("onPart rejects"))], ["never settles", () => new Promise(() => undefined)]]) {
		const waits = s.waits.length;
		const f = follow(s.client, { kind: "note", since: 0 }, { onPart });
		await until(() => s.waits.length === waits + 1, `${what}: the host waiting`);
		await until(() => f.parts.length === 2, `${what}: every part given`);
		const ending = await f.stop();
		assert.deepEqual([ending.ending, ending.answer], ["answered", { position: 2 }], `${what}: the ending stands`);
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(unhandled, [], "no rejection left unhandled");
});
