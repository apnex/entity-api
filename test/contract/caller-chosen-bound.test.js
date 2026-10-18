// caller-chosen-bound (carried from operation-call) - a remote caller sets each operation's bound: total time
// for a whole answer (zorg's target, EM10, EM12; E15).
//
// Cases, with the call bound on a controlled clock and every answer withheld: each operation the client offers
// ends unknown exactly at the bound its caller gave - the call's own or the client's - and not a millisecond
// before; the whole find's bound is one deadline for all its pages, from the moment it is called, however its
// pages spend it; and a bound outside 1 to 2147483647 milliseconds, or not whole, is a programming error,
// thrown with nothing sent - an explicit null bound included, for all nine methods, with a client bound and
// without, never replaced by the client's (stage 5's fifth verification, F3) - as is an abort signal given that is not one - null, one without aborted, one whose
// aborted is not a boolean - for findPage, a write, a read, the whole find, changesPage and the whole changes, with time left and after a slow
// signal getter has spent the whole bound, a genuine signal and none given as controls. With operation-call's default clock, a whole find's clock is read as it is called,
// before its input and options are read, and no page is answered after its deadline: time passing in their
// getters spent from the bound, a slow signal, bound or input getter using the bound up before the first page,
// as findPage ends for the same input, time passing in the first and a later page's preparation, and a final
// page that cannot be accepted, each with wide margins.
// Every single call delegates directly to the call layer's caller (EM10, EM12; zorg's D55), whose bound starts
// as it reads its clock, before it reads the call's options: on the controlled clock, each operation given a
// slow bound getter hands the call layer the bound unchanged, and spending part of it the call answers, while
// spending all of it the call layer ends it unknown with bound-passed, whole, under its own new identity and a
// new attempt of it, nothing sent; on the default clock, findPage, a write and a read given a slow signal, bound
// or invocation getter outlasting the bound end so, under the identity given or a new one, nothing sent, and one
// spending part of it is answered, the call layer given the bound as the application gave it. Over a caller
// that reads its request as operation-call's does, with a client clock that throws if read, each of the six
// single calls reads no option before the caller's clock, each at most once, repeat for a write only, the
// bound by default the client's, and returns the caller's ending unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStoreClient } from "@apnex/entity-api";
import { readCallRequest } from "@apnex/operation-call";
import { openTopology, preparingIdentities, turn, until, within } from "../support/topology.js";
import { answerOf, clientOf, nodeEvidence, openStore, serve } from "../support/serving.js";

/** A store served with its requests held at the evidence port until released, so no answer comes. */
async function withheld(t) {
	const topology = await openTopology({ callers: ["alice"] });
	const releases = [];
	t.after(() => { for (const r of releases) r(); return topology.close(); });
	const { store } = openStore({ maxEntityBytes: 262_144 });
	let hold = true;
	let arrived = 0;
	await serve(topology, { store, evidence: (delivery) => {
		arrived++;
		if (!hold) return nodeEvidence(delivery);
		return new Promise((resolve) => releases.push(() => resolve(nodeEvidence(delivery))));
	} });
	return { topology, store, entry: topology.caller("alice"), arrived: () => arrived, setHold: (h) => { hold = h; } };
}

test("each operation ends unknown exactly at the bound its caller gave, the call's own or the client's, and not before", async (t) => {
	const { topology, arrived } = await withheld(t);
	const client = clientOf(topology, "alice", { bound: 300 });
	const calls = [
		[() => client.create({ kind: "any", name: "n", tags: [], body: 0 }, { bound: 250 }), 250],
		[() => client.update({ target: { id: "e1.1" }, body: 1 }), 300],
		[() => client.delete({ target: { id: "e1.1" } }, { bound: 1 }), 1],
		[() => client.read({ target: { id: "e1.1" } }, { bound: 777 }), 777],
		[() => client.findPage({ kind: "any" }), 300],
		[() => client.find({ kind: "any" }, { bound: 120 }), 120],
		[() => client.historyBound({ bound: 2 }), 2],
		[() => client.changesPage({ since: 0 }, { bound: 333 }), 333],
		[() => client.changes({ since: 0 }, { bound: 130 }), 130],
	];
	for (const [i, [call, bound]] of calls.entries()) {
		let ending;
		const pending = call().then((e) => { ending = e; });
		await until(() => arrived() === i + 1, "the request to reach the host");
		if (bound > 1) topology.hooks.advanceCallClock(bound - 1);
		for (let k = 0; k < 5; k++) await turn();
		assert.equal(ending, undefined, `no ending a millisecond before ${bound}`);
		topology.hooks.advanceCallClock(1);
		await within(pending);
		assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"], `ended at ${bound}`);
	}
});

test("a whole find's bound is one deadline for all its pages, from the moment it is called", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	const held = Promise.withResolvers();
	t.after(() => { held.resolve(); return topology.close(); });
	const opened = openStore({ maxEntityBytes: 262_144 });
	for (let i = 1; i <= 5; i++) opened.store.create({ kind: "any", name: `e${i}`, tags: [], body: { pad: "x".repeat(200_000) } }, { writer: "w", writeId: `${i}` });
	let pages = 0;
	let requests = 0;
	const store = { checkRepeat: (...a) => opened.store.checkRepeat(...a), read: (...a) => opened.store.read(...a), historyBound: () => opened.store.historyBound(), changes: (...a) => opened.store.changes(...a), create: (...a) => opened.store.create(...a), update: (...a) => opened.store.update(...a), delete: (...a) => opened.store.delete(...a),
		find(input) {
			const page = opened.store.find(input);
			// The first page's answer leaves 600 ms; the second's 249.5.
			topology.hooks.moveCallClock(++pages === 1 ? 400 : 350.5);
			return page;
		} };
	await serve(topology, { store, evidence: (delivery) => (delivery.destination === "store/find" && ++requests === 3 ? held.promise.then(() => nodeEvidence(delivery)) : nodeEvidence(delivery)) });
	const entry = topology.caller("alice");
	const pending = clientOf(topology, "alice", { bound: 1000 }).find({ kind: "any" });
	await until(() => requests === 3, "the third page, held at the host");
	assert.deepEqual(entry.calls.map((c) => c.bound), [1000, 600, 249], "each page given only what is left of the one bound, rounded down");
	topology.hooks.advanceCallClock(249);
	const ending = await within(pending);
	assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"], "the find ends at its one deadline, 1000 ms after it was called");
	assert.equal(ending.invocation, (await entry.endings[0]).invocation);
});

test("every single call hands the call layer its bound, which starts as the call layer reads its clock, before the bound getter runs: a slow bound getter spending part of it leaves the call time to answer, and spending all of it the call layer ends the call unknown at its bound with nothing sent", async (t) => {
	const { topology, entry, arrived, setHold } = await withheld(t);
	setHold(false);
	const client = clientOf(topology, "alice", { bound: 300 });
	const operations = [
		["create", (o) => client.create({ kind: "any", name: "n", tags: [], body: 0 }, o)],
		["update", (o) => client.update({ target: { id: "e1.1" }, body: 1 }, o)],
		["delete", (o) => client.delete({ target: { id: "e1.1" } }, o)],
		["read", (o) => client.read({ target: { id: "e1.1" } }, o)],
		["find", (o) => client.findPage({ kind: "any" }, o)],
		["history-bound", (o) => client.historyBound(o)],
		["changes", (o) => client.changesPage({ since: 0 }, o)],
	];
	let reads = 0;
	const slowBound = (ms, bound) => ({ get bound() { reads++; topology.hooks.moveCallClock(ms); return bound; } });
	for (const [operation, call] of operations) {
		reads = 0;
		const sent = arrived();
		const answered = await within(call(slowBound(100.6, 250)));
		assert.deepEqual([entry.calls.at(-1).operation, entry.calls.at(-1).bound], [operation, 250], `${operation}: the bound handed on as given`);
		assert.equal(answered, await entry.endings.at(-1), `${operation}: the call layer's ending, unchanged`);
		assert.notEqual(answered.reason, "bound-passed", `${operation}: 149.4 ms left once the getter ran, so the call was sent`);
		assert.equal(arrived(), sent + 1, `${operation}: sent`);
		const ending = await within(call(slowBound(250, 250)));
		assert.deepEqual({ ...ending, invocation: "", attempt: "" }, { ending: "unknown", invocation: "", attempt: "", operation, reason: "bound-passed", agpCode: null, deliveryReport: null }, `${operation}: its bound spent`);
		assert.match(ending.invocation, /^[0-9]{13}-[0-9a-f]{16}$/, `${operation}: a new invocation identity`);
		assert.ok(ending.attempt.startsWith(`${ending.invocation}.`), `${operation}: a new attempt of it`);
		assert.ok(Object.isFrozen(ending));
		assert.equal(ending, await entry.endings.at(-1), `${operation}: the call layer's own ending, unchanged`);
		assert.equal(arrived(), sent + 1, `${operation}: nothing sent once its bound was spent`);
		assert.equal(reads, 2, `${operation}: each bound getter read once`);
	}
	assert.equal(arrived(), operations.length, "only the calls left time were sent");
});

test("each single call delegates to its caller, keeping no clock: no option is read before the caller reads its clock, each is read at most once, repeat is read and forwarded for a write only, the bound defaults to the client's, and the caller's ending is returned unchanged", async () => {
	const ID = "1791540000000-0123456789abcdef";
	const log = [];
	const returned = [];
	const caller = {
		async invoke(request) {
			log.push("clock");
			const read = readCallRequest(request);
			log.push("read");
			// Read again: the same value, and no option of the application's read a second time (the log shows it).
			for (const name of ["bound", "invocation", "signal"]) assert.equal(request[name], read[name], `${name} read again gives the value first read`);
			assert.equal(request.repeat === true, read.repeat, "repeat read again gives the value first read");
			const ending = Object.freeze({ ending: "answered", invocation: read.invocation ?? ID, attempt: `${ID}.00000001`, operation: read.operation, answer: { bound: read.bound, repeat: read.repeat, keys: Object.keys(request) } });
			returned.push(ending);
			return ending;
		},
	};
	const client = createStoreClient({ caller, host: "host-a", service: "store", bound: 777, clock: { now() { throw new Error("a single call reads no clock of entity-api's"); } } });
	const signal = new AbortController().signal;
	const options = () => ({
		get bound() { log.push("bound"); return 1234; },
		get invocation() { log.push("invocation"); return ID; },
		get repeat() { log.push("repeat"); return true; },
		get signal() { log.push("signal"); return signal; },
	});
	const calls = {
		create: [(o) => client.create({ kind: "any", name: "n", tags: [], body: 0 }, o), true],
		update: [(o) => client.update({ target: { id: "e1.1" }, body: 1 }, o), true],
		delete: [(o) => client.delete({ target: { id: "e1.1" } }, o), true],
		read: [(o) => client.read({ target: { id: "e1.1" } }, o), false],
		find: [(o) => client.findPage({ kind: "any" }, o), false],
		"history-bound": [(o) => client.historyBound(o), false],
		changes: [(o) => client.changesPage({ since: 0 }, o), false],
	};
	for (const [operation, [call, write]] of Object.entries(calls)) {
		log.length = 0;
		const ending = await call(options());
		assert.deepEqual(log, write ? ["clock", "bound", "invocation", "repeat", "signal", "read"] : ["clock", "bound", "invocation", "signal", "read"], `${operation}: every option read once, after the caller's clock`);
		assert.equal(ending, returned.at(-1), `${operation}: the caller's ending, unchanged`);
		assert.deepEqual([ending.operation, ending.answer.bound, ending.answer.repeat], [operation, 1234, write], operation);
		assert.deepEqual(ending.answer.keys, ["host", "service", "operation", "input", "bound", "invocation", ...(write ? ["repeat"] : []), "signal"], `${operation}: repeat in a write's request only`);
		for (const given of [undefined, {}]) assert.equal((await call(given)).answer.bound, 777, `${operation}: the client's bound by default`);
		await assert.rejects(call("fast"), TypeError, `${operation}: options neither an object nor absent, thrown as the caller reads them`);
	}
});

test("a bound outside 1 to 2147483647 milliseconds, or not whole, is a programming error, thrown with nothing sent", async (t) => {
	const { topology, store } = await withheld(t);
	const client = clientOf(topology, "alice");
	for (const bound of [0, -1, 2147483648, 1.5, Number.NaN, "10"]) {
		await assert.rejects(client.read({ target: { id: "e1.1" } }, { bound }), RangeError, `read, ${bound}`);
		await assert.rejects(client.create({ kind: "any", name: "n", tags: [], body: 0 }, { bound }), RangeError, `create, ${bound}`);
		await assert.rejects(client.find({ kind: "any" }, { bound }), RangeError, `find, ${bound}`);
	}
	assert.equal(store.historyBound().answer.position, 0);
});

test("an explicit null bound is a bound given, never replaced by the client's: each of the nine methods given { bound: null } throws a RangeError with nothing sent, whether the client has a bound of its own or none (stage 5's fifth verification, F3)", async (t) => {
	const { topology, store, setHold, arrived } = await withheld(t);
	setHold(false);
	const clients = {
		"a client bound of 100": createStoreClient({ caller: topology.caller("alice").caller, host: "host-a", service: "store", bound: 100, clock: topology.callClock }),
		"no client bound": createStoreClient({ caller: topology.caller("alice").caller, host: "host-a", service: "store", clock: topology.callClock }),
	};
	for (const [which, client] of Object.entries(clients)) {
		const calls = {
			create: () => client.create({ kind: "any", name: "n", tags: [], body: 0 }, { bound: null }),
			read: () => client.read({ target: { id: "e1.1" } }, { bound: null }),
			update: () => client.update({ target: { id: "e1.1" }, body: 1 }, { bound: null }),
			delete: () => client.delete({ target: { id: "e1.1" } }, { bound: null }),
			find: () => client.find({ kind: "any" }, { bound: null }),
			findPage: () => client.findPage({ kind: "any" }, { bound: null }),
			historyBound: () => client.historyBound({ bound: null }),
			changesPage: () => client.changesPage({ since: 0 }, { bound: null }),
			changes: () => client.changes({ since: 0 }, { bound: null }),
		};
		for (const [method, call] of Object.entries(calls)) {
			await assert.rejects(within(call()), RangeError, `${which}, ${method}`);
		}
	}
	assert.equal(arrived(), 0, "no request reached the host");
	assert.equal(store.historyBound().answer.position, 0, "nothing was written");
	assert.equal(answerOf(await within(clients["a client bound of 100"].create({ kind: "any", name: "n", tags: [], body: 0 }))).position, 1, "with the bound absent, the client's is used, and the host serves");
});

test("an abort signal given that is not one - null, one without aborted, one whose aborted is not a boolean - is a programming error of findPage, a write, a read, the whole find, changesPage and the whole changes, thrown with time left and after a slow signal getter has spent the whole bound, with nothing sent; a genuine signal and none given are not", async (t) => {
	const { topology, entry, store, setHold, arrived } = await withheld(t);
	setHold(false);
	const client = clientOf(topology, "alice", { bound: 300 });
	let written = 0;
	const calls = {
		findPage: (o) => client.findPage({ kind: "any" }, o),
		write: (o) => client.create({ kind: "any", name: `n${++written}`, tags: [], body: 0 }, o),
		read: (o) => client.read({ target: { id: "e1.1" } }, o),
		find: (o) => client.find({ kind: "any" }, o),
		changesPage: (o) => client.changesPage({ since: 0 }, o),
		changes: (o) => client.changes({ since: 0 }, o),
	};
	const malformed = { "a null signal": () => null, "a signal without aborted": () => ({}), "a signal whose aborted is not a boolean": () => ({ aborted: "no" }) };
	const signalOf = (value, spend) => ({ get signal() { if (spend) topology.hooks.moveCallClock(spend); return value; } });
	for (const [name, call] of Object.entries(calls)) {
		for (const spend of [0, 300]) {
			const when = spend === 0 ? "with time left" : "its getter spending the whole bound";
			for (const [what, make] of Object.entries(malformed)) {
				const before = arrived();
				await assert.rejects(within(call(signalOf(make(), spend))), TypeError, `${name}, ${what}, ${when}`);
				assert.equal(arrived(), before, `${name}, ${what}, ${when}: nothing sent`);
			}
			for (const [what, value] of [["a genuine signal", new AbortController().signal], ["none given", undefined]]) {
				const before = arrived();
				const ending = await within(call(signalOf(value, spend)));
				if (spend === 0) {
					assert.equal(arrived(), before + 1, `${name}, ${what}, ${when}: sent`);
					assert.equal(entry.calls.at(-1).signal, value, `${name}, ${what}, ${when}: the signal handed on as given`);
					if (name === "find" || name === "changes") assert.equal(ending.ending, "answered", `${name}, ${what}, ${when}`);
					else assert.equal(ending, await entry.endings.at(-1), `${name}, ${what}, ${when}: the call layer's ending, unchanged`);
				} else {
					assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"], `${name}, ${what}, ${when}`);
					assert.equal(arrived(), before, `${name}, ${what}, ${when}: nothing sent`);
				}
			}
		}
	}
	assert.equal(store.historyBound().answer.position, 2, "only the two writes given time and a genuine signal or none were applied");
});

/** Spends real time synchronously, as a slow getter or port of the caller's would. */
const busy = (ms) => { const end = performance.now() + ms; while (performance.now() < end); };

/** A topology on operation-call's default clock, with three entities of about 200 KB served, so a find takes two pages. */
async function realClock(t, { identities, find } = {}) {
	const topology = await openTopology({ callers: ["alice"], realCallClock: true, ...(identities ? { identities } : {}) });
	t.after(() => topology.close());
	const opened = openStore({ maxEntityBytes: 262_144 });
	for (let i = 1; i <= 3; i++) opened.store.create({ kind: "any", name: `e${i}`, tags: [], body: { pad: "x".repeat(200_000) } }, { writer: "w", writeId: `${i}` });
	let pages = 0;
	const store = { ...Object.fromEntries(["create", "update", "delete", "read", "historyBound", "changes", "checkRepeat"].map((m) => [m, (...a) => opened.store[m](...a)])),
		find(input) { const n = ++pages; const page = opened.store.find(input); find?.(n); return page; } };
	await serve(topology, { store });
	return { topology, entry: topology.caller("alice"), pages: () => pages };
}

test("on the default clock, time spent in a find's option and input getters is spent from its bound, read as the find was called", async (t) => {
	const { topology, entry } = await realClock(t);
	const client = clientOf(topology, "alice", { bound: 60_000, clock: topology.callClock });
	const options = { get bound() { busy(150); return 60_000; }, get signal() { busy(150); return undefined; } };
	const input = { get kind() { busy(150); return "any"; } };
	answerOf(await within(client.find(input, options)));
	assert.ok(entry.calls[0].bound <= 59_550, `the first page's bound, ${entry.calls[0].bound}, has the 450 ms spent in getters taken from it`);
});

test("on the default clock, a slow signal getter, a slow bound getter or a slow input getter outlasting the find's bound ends it unknown at its bound, attempt null, with no page sent, as findPage ends for the same input", async (t) => {
	const { topology, entry, pages } = await realClock(t);
	const client = clientOf(topology, "alice", { bound: 1000, clock: topology.callClock });
	const slow = (value) => { busy(1500); return value; };
	const preparations = {
		signal: () => [{ kind: "any" }, { get signal() { return slow(undefined); } }],
		bound: () => [{ kind: "any" }, { get bound() { return slow(1000); } }],
		input: () => [{ get kind() { return slow("any"); } }, {}],
	};
	for (const [what, prepare] of Object.entries(preparations)) {
		const ending = await within(client.find(...prepare()));
		assert.deepEqual([ending.ending, ending.reason, ending.attempt, ending.agpCode, ending.deliveryReport], ["unknown", "bound-passed", null, null, null], what);
	}
	assert.equal(entry.calls.length, 0, "no page was sent");
	const page = await within(client.findPage(...preparations.input()));
	assert.deepEqual([page.ending, page.reason, page.agpCode, page.deliveryReport], ["unknown", "bound-passed", null, null], "findPage ends at its bound for the same input");
	assert.ok(page.attempt.startsWith(`${page.invocation}.`), "findPage's ending with a new attempt of its invocation, as the find's is null");
	assert.equal(entry.calls.length, 1, "findPage delegated to the call layer, which read the input after its clock");
	assert.equal(page, await entry.endings[0], "and ended it as the call layer did");
	assert.equal(pages(), 0, "nothing reached the store");
});

test("on the default clock, a slow signal, bound or invocation getter outlasting the bound of findPage, a write or a read ends the call unknown at its bound, nothing sent, under the identity given or a new one with a new attempt identity of it, as the call layer ends it; one spending part of it is answered, the call layer given the bound as given", async (t) => {
	const { topology, entry, pages } = await realClock(t);
	const client = clientOf(topology, "alice", { bound: 1000, clock: topology.callClock });
	const ID = "1791540000000-0123456789abcdef";
	let made = 0;
	const singles = [
		["find", (o) => client.findPage({ kind: "any" }, o)],
		["create", (o) => client.create({ kind: "any", name: `n${++made}`, tags: [], body: 0 }, o)],
		["read", (o) => client.read({ target: { kind: "any", name: "e1" } }, o)],
	];
	const slow = (ms, value) => { busy(ms); return value; };
	const getters = {
		signal: (ms, invocation, bound) => ({ bound, ...(invocation ? { invocation } : {}), get signal() { return slow(ms, undefined); } }),
		bound: (ms, invocation, bound) => ({ ...(invocation ? { invocation } : {}), get bound() { return slow(ms, bound); } }),
		invocation: (ms, invocation, bound) => ({ bound, get invocation() { return slow(ms, invocation); } }),
	};
	let k = 0;
	for (const [operation, call] of singles) {
		for (const [what, options] of Object.entries(getters)) {
			const given = k++ % 2 === 0 ? ID : undefined;
			const ending = await within(call(options(1200, given, 1000)));
			const label = `${operation}, a slow ${what} getter, ${given ? "the identity given" : "none given"}`;
			assert.deepEqual({ ...ending, invocation: "", attempt: "" }, { ending: "unknown", invocation: "", attempt: "", operation, reason: "bound-passed", agpCode: null, deliveryReport: null }, label);
			assert.match(ending.invocation, given ? /^1791540000000-0123456789abcdef$/ : /^[0-9]{13}-[0-9a-f]{16}$/, label);
			assert.match(ending.attempt, /^[0-9]{13}-[0-9a-f]{16}\.[0-9a-f]{8}$/, label);
			assert.ok(ending.attempt.startsWith(`${ending.invocation}.`), `${label}: an attempt of that invocation`);
			assert.ok(Object.isFrozen(ending), label);
			assert.equal(ending, await entry.endings.at(-1), `${label}: the call layer's ending, unchanged`);
		}
	}
	assert.equal(entry.calls.length, 9, "each call delegated to the call layer");
	assert.equal(pages(), 0, "nothing reached the store");
	for (const [operation, call] of singles) {
		for (const [what, options] of Object.entries(getters)) {
			const given = what === "invocation" ? entry.caller.newInvocation() : undefined;
			const ending = await within(call(options(150, given, 60_000)));
			const made = entry.calls.at(-1);
			assert.equal(made.operation, operation);
			assert.equal(made.bound, 60_000, `${operation}, a slow ${what} getter: the call layer given the bound as given, its own clock spending the 150 ms from it`);
			assert.equal(ending.ending, "answered", `${operation}, a slow ${what} getter`);
		}
	}
});

test("on the default clock, a first or later page whose preparation outlasts the find's bound is never answered: the find ends unknown at its bound", async (t) => {
	for (const page of [1, 2]) {
		const { source, hooks } = preparingIdentities();
		const { topology, entry, pages } = await realClock(t, { identities: source });
		hooks.attempt = (n) => { if (n === page) busy(1500); };
		const ending = await within(clientOf(topology, "alice", { bound: 1000, clock: topology.callClock }).find({ kind: "any" }));
		assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"], `preparing page ${page}`);
		assert.ok(pages() < page, `page ${page} was never served`);
		assert.ok(entry.calls.length <= page, "no page after it");
	}
});

test("on the default clock, a final page that cannot be accepted, answering after the find's deadline, ends the find unknown at its bound, not answered", async (t) => {
	const { topology } = await realClock(t, { find: (n) => { if (n === 2) busy(1500); } });
	const ending = await within(clientOf(topology, "alice", { bound: 1000, clock: topology.callClock }).find({ kind: "any" }));
	assert.deepEqual([ending.ending, ending.reason], ["unknown", "bound-passed"], "the final page answered after the deadline is not taken");
	let pages = 0;
	const caller = { async invoke(call) {
		pages++;
		if (pages === 2) busy(call.bound + 300);
		return { ending: "answered", invocation: "1791540000000-0123456789abcdef", attempt: "1791540000000-0123456789abcdef.0000000" + pages, operation: "find", answer: { position: 3, entries: [], next: pages === 1 ? "a" : null } };
	} };
	const late = await createStoreClient({ caller, host: "host-a", service: "store", bound: 1000, clock: topology.callClock }).find({ kind: "any" });
	assert.deepEqual([late.ending, late.reason, late.attempt], ["unknown", "bound-passed", "1791540000000-0123456789abcdef.00000001"], "a caller answering after the deadline is not taken");
});
