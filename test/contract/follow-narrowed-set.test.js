// follow-narrowed-set (carried from entity-store) - a remote follow reports entities entering, changing within
// and leaving the narrowed set, once and in order (zorg's target, EM17, EM18; Delta 4's D4-E7).
//
// The shared suite's follow cases run locally and remotely in shared-suite.test.js. Here, a store served on host-a
// and followed through the client half over AGP's production in-process carrier: one part per item, exactly its
// answer and `through`, a checkpoint when a page's `through` passes the last part's, a page with no item
// included, none when it does not, across pages of more than 524288 bytes; parts for changes made after following
// began, the host waiting between them; a change made between a page and its wait, not missed; an envelope of 27
// levels in a part; a change of two writes, recovered from a log, its first item's `through` one less than its
// position; a later page refused, ending the call refused after its parts; an input beyond the shape refused
// `input-misfit`, the same input followed locally; and a store without `follow` and `waitForChange` refused by
// serveStore.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryStoragePort } from "@apnex/entity-store";
import { serveStore } from "@apnex/entity-api";
import { openTopology, until, within } from "../support/topology.js";
import { clientOf, note, openStore, serve, T0 } from "../support/serving.js";

const iso = (ms) => new Date(ms).toISOString();

/** A store wrapped so a test sees each page the host asks for and each wait it begins, and may change either. */
function watchedStore(store, { onFollow, onWait } = {}) {
	const pages = [];
	const waits = [];
	let asked = 0;
	const methods = ["create", "update", "delete", "read", "find", "historyBound", "changes", "checkRepeat"];
	const wrapper = Object.fromEntries(methods.map((m) => [m, (...args) => store[m](...args)]));
	wrapper.follow = (input) => {
		const n = ++asked;
		const page = onFollow?.(input, n) ?? store.follow(input);
		pages.push({ input, page });
		return page;
	};
	wrapper.waitForChange = (after, options) => {
		const waiting = onWait?.(after, options, waits.length + 1) ?? store.waitForChange(after, options);
		const entry = { after, settled: false, outcome: undefined };
		waits.push(entry);
		waiting.then((v) => { entry.settled = true; entry.outcome = v; }, (e) => { entry.settled = true; entry.outcome = e; });
		return waiting;
	};
	return { store: wrapper, pages, waits };
}

/** A topology with a store served on host-a, the host keeping time on the topology's call clock. */
async function setup(t, { storeOptions = {}, wrap, ...serveOptions } = {}) {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const opened = openStore({ maxEntityBytes: 262_144, ...storeOptions });
	const watched = watchedStore(opened.store, wrap);
	await serve(topology, { store: watched.store, clock: topology.callClock, ...serveOptions });
	return { topology, ...opened, raw: opened.store, served: watched.store, pages: watched.pages, waits: watched.waits, client: clientOf(topology, "alice") };
}

/** Starts a follow collecting every part's answer; `stop()` cancels it and gives its ending. */
function follow(client, input) {
	const parts = [];
	const controller = new AbortController();
	const ending = client.follow(input, { signal: controller.signal, onPart: (part) => { parts.push(part); } });
	return { parts, ending, stop: async () => { controller.abort(); return within(ending); } };
}

/** Every item the store's own follow gives from `since`, across its pages, as the host reads them. */
function storeItems(store, input) {
	const items = [];
	let since = input.since;
	for (;;) {
		const page = store.follow({ ...input, since }).answer;
		items.push(...page.changes);
		if (page.through === page.position) return items;
		since = page.through;
	}
}

const big = (name, tags) => ({ kind: "any", name, tags, body: { pad: "x".repeat(200_000) } });
const writer = { writer: "seed" };
let seeds = 0;
const seed = (store, input) => store.create(input, { ...writer, writeId: `seed-${++seeds}` }).answer;

test("one part per item, exactly its answer and through; a checkpoint once a page's items are sent when its through passes the last part's, a page with no item included, and none when it does not; across pages of more than 524288 bytes", async (t) => {
	const s = await setup(t);
	seed(s.store, big("in-1", ["set:yes"]));
	seed(s.store, big("out-1", ["set:no"]));
	seed(s.store, big("in-2", ["set:yes"]));
	seed(s.store, big("in-3", ["set:yes"]));
	seed(s.store, note("out-2", ["set:no"]));
	const expected = storeItems(s.store, { kind: "any", tags: ["set:yes"], since: 0 });
	const f = follow(s.client, { kind: "any", tags: ["set:yes"], since: 0 });
	await until(() => s.waits.length === 1, "the host waiting");
	assert.deepEqual(s.pages.map((p) => [p.input.since, p.page.answer.through, p.page.answer.changes.length]), [[0, 3, 2], [3, 5, 1]], "two pages, the first stopping before the item that would pass 524288 bytes");
	await until(() => f.parts.length === 4, "four parts");
	assert.deepEqual(f.parts, [
		{ through: 1, change: expected[0] },
		{ through: 3, change: expected[1] },
		{ through: 4, change: expected[2] },
		{ through: 5, change: null },
	], "items with their positions as through; no checkpoint after the first page, whose through is its last item's; one after the second, past its last item");
	const deeplyFrozen = (v) => v === null || typeof v !== "object" || (Object.isFrozen(v) && Object.values(v).every(deeplyFrozen));
	assert.ok(f.parts.every(deeplyFrozen), "each part's answer deeply frozen");
	// A page with no item: a change outside the set passes, and a checkpoint says so.
	seed(s.store, note("out-3", ["set:no"]));
	await until(() => f.parts.length === 5, "a checkpoint for a page with no item");
	assert.deepEqual(f.parts[4], { through: 6, change: null });
	const ending = await f.stop();
	assert.deepEqual([ending.ending, ending.answer], ["answered", { position: 6 }], "answered with the last part's through");
});

test("parts for changes made after following began, the host waiting between them; an envelope of 27 levels in a part", async (t) => {
	const s = await setup(t);
	const f = follow(s.client, { kind: "any", tags: ["set:yes"], since: 0 });
	await until(() => s.waits.length === 1, "the host waiting on an empty store");
	assert.equal(f.parts.length, 0, "nothing to send");
	let deep = "core";
	for (let i = 0; i < 26; i++) deep = [deep];
	const made = seed(s.store, { kind: "any", name: "deep", tags: ["set:yes"], body: deep });
	await until(() => f.parts.length === 1, "the change made after following began");
	assert.deepEqual(f.parts[0], { through: 1, change: { event: "entering", position: 1, at: iso(T0), writer: "seed", id: made.entity.id, entity: made.entity } }, "the envelope of 27 levels, whole");
	await until(() => s.waits.length === 2, "the host waiting again");
	seed(s.store, note("alpha", ["set:yes"]));
	await until(() => f.parts.length === 2, "the next");
	assert.equal(f.parts[1].through, 2);
	await f.stop();
});

test("a change made between a page and the host's wait is not missed: the wait resolves at once and the next page holds it", async (t) => {
	let raw;
	const s = await setup(t, { wrap: { onFollow: (input, n) => {
		const page = raw.follow(input);
		// Made after the first page is read and before the host waits.
		if (n === 1) seed(raw, note("between", ["set:yes"]));
		return page;
	} } });
	raw = s.raw;
	seed(s.store, note("first", ["set:yes"]));
	const f = follow(s.client, { kind: "note", tags: ["set:yes"], since: 0 });
	await until(() => f.parts.length === 2, "both changes");
	assert.deepEqual(f.parts.map((p) => [p.through, p.change.entity.name]), [[1, "first"], [2, "between"]]);
	assert.equal(s.waits[0].after, 1, "the host waited from the first page's through");
	assert.equal(s.waits[0].outcome, 2, "and the wait resolved at once with the store's position");
	await f.stop();
});

test("a change of two writes, recovered from a log, gives its first item a through one less than its position and its last its position", async (t) => {
	const storage = createMemoryStoragePort();
	const at = iso(T0);
	const env = (id, name, position, revision, created) => ({ id, kind: "note", name, tags: ["set:yes"], body: { pointer: `https://example.com/${name}`, summary: `about ${name} ${revision}` }, revision, created: { position: created, at, writer: "fixture" }, changed: { position, at, writer: "fixture" } });
	const alpha = env("e1.1", "alpha", 1, 1, 1);
	const alpha2 = env("e1.1", "alpha", 2, 2, 1);
	const beta = env("e2.2", "beta", 2, 1, 2);
	storage.append({ type: "change", position: 1, at, writer: "fixture", writeId: "f1", digest: "0".repeat(64), answer: { position: 1, entity: alpha }, writes: [{ operation: "create", id: "e1.1", entity: alpha }] });
	storage.append({ type: "change", position: 2, at, writer: "fixture", writeId: "f2", digest: "0".repeat(64), answer: { position: 2, entity: alpha2 }, writes: [{ operation: "update", id: "e1.1", entity: alpha2 }, { operation: "create", id: "e2.2", entity: beta }] });
	const s = await setup(t, { storeOptions: { storage } });
	const f = follow(s.client, { kind: "note", tags: ["set:yes"], since: 0 });
	await until(() => f.parts.length === 3, "three items");
	assert.deepEqual(f.parts.map((p) => [p.through, p.change.event, p.change.id]), [[1, "entering", "e1.1"], [1, "changing", "e1.1"], [2, "entering", "e2.2"]], "the change of two writes: its first item's through 1, its last 2");
	assert.deepEqual((await f.stop()).answer, { position: 2 });
});

test("a later page the store refuses ends the call refused with the store's record, after the parts already sent", async (t) => {
	const refusal = { part: "entity-store", code: "position-not-held", what: "w", why: "y", fix: "f", details: { position: 1 } };
	const s = await setup(t, { wrap: { onFollow: (_input, n) => (n === 2 ? { outcome: "refused", refusal } : undefined) } });
	seed(s.store, note("alpha", ["set:yes"]));
	const f = follow(s.client, { kind: "note", since: 0 });
	await until(() => s.waits.length === 1, "the host waiting after the first page");
	seed(s.store, note("beta", ["set:yes"]));
	const ending = await within(f.ending);
	assert.deepEqual([ending.ending, ending.refusal], ["refused", refusal], "refused with the store's record, unchanged");
	assert.deepEqual(f.parts.map((p) => p.through), [1], "the part sent before it stands");
});

test("an input beyond follow's shape - a kind of 64 characters, 33 tags, a tag of 128 characters - is refused input-misfit before the policy, while the store's own follow takes it", async (t) => {
	const asked = [];
	const s = await setup(t, { policy: (q) => { asked.push(q.operation); return { allowed: true }; } });
	const many = Array.from({ length: 33 }, (_, i) => `k${i}:v`);
	for (const [what, input] of [["a kind of 64 characters", { kind: "k".repeat(64), since: 0 }], ["33 tags", { kind: "note", tags: many, since: 0 }], ["a tag of 128 characters", { kind: "note", tags: ["t".repeat(128)], since: 0 }]]) {
		const ending = await within(s.client.follow(input, { onPart: () => undefined }));
		assert.deepEqual([ending.ending, ending.refusal?.code], ["refused", "input-misfit"], what);
	}
	assert.deepEqual(asked, [], "the policy was not asked");
	assert.deepEqual(s.store.follow({ kind: "note", tags: many, since: 0 }).answer, { position: 0, through: 0, changes: [] }, "the store's own follow takes 33 tags");
});

test("serveStore needs a store offering follow and waitForChange", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const { store } = openStore();
	for (const missing of ["follow", "waitForChange"]) {
		const partial = Object.fromEntries(["create", "update", "delete", "read", "find", "historyBound", "changes", "follow", "waitForChange", "checkRepeat"].filter((m) => m !== missing).map((m) => [m, (...a) => store[m](...a)]));
		await assert.rejects(serveStore({ node: topology.hostNodes.get("host-a"), service: "store", store: partial, nameWriter: () => "w", policy: () => ({ allowed: true }) }), TypeError, `a store without ${missing}`);
	}
});
