// ask-application-policy - before each operation the host asks the application whether the caller may act;
// it never decides (zorg's target, EM13; E5).
//
// Cases: a remote fixture observes the policy asked before each of the six operations, with the operation,
// the input, the caller's evidence, the writer named, the target and whether the write is a recognised
// repeat; EM13's synchronous order of a write - writer, retention and digest, target resolution, policy,
// store - observed step by step for a create, an update, a delete, a recognised repeat and a reused identity;
// no change lands between a ruling and its write; a denial is returned unchanged and takes no position, for
// every operation; zorg's rule as a fixture application, end to end; a repeated rename whose old name another
// agent has since taken; a policy that throws, rules asynchronously, rules in another form, or allows a
// write no writer was named for, each ending the invocation unknown with nothing written; the ruling's fields
// each read once, and a refusal that is a promise, rejecting at once or later, ending the invocation unknown
// with its outcome consumed, nothing written, and the host serving on; a promise as the ruling's allowed, or
// within its refusal, rejecting at once or later, for a create and a read, the same, in a child process with
// no process-wide rejection handler; and the same for a promise beside a getter, at the ruling's top level,
// in a nested refusal object and in a refusal array member, and for every form of stage 5's fourth
// verification. The ruling and its refusal are read as plain data (zorg's D54, D55): no getter, then probe,
// inherited field or other code of theirs ever runs - a then getter throwing, giving a promise or giving a
// function, enumerable or not, on the ruling, its refusal or a refusal member, a getter before it, a promise
// in an own data property named then or hidden as non-enumerable, a class instance, an inherited, symbol,
// non-enumerable or extra field, an invalid EM9 refusal, and a Proxy whose traps throw each end the
// invocation unknown with operation-failed, getters unread, every promise met observed, nothing written, no
// rejection unhandled, and the host serving on; a plain ruling, null-prototype ones and data named then
// included, is taken, its refusal passed on as it was read; the input, the evidence and the target
// given as deeply frozen JSON snapshots, which the policy cannot change; describe, operation-call's own,
// ruled on by no policy and naming no writer; and a policy's denial winning over a reused identity.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openTopology, within } from "../support/topology.js";
import { answerOf, clientOf, note, openStore, serve } from "../support/serving.js";
import { policyRefusal, recordingStore, writerOnlyPolicy } from "../support/policies.js";

async function setup(t, { policy, nameWriter, callers = ["alice", "bob"], log = [] } = {}) {
	const topology = await openTopology({ callers });
	t.after(() => topology.close());
	const opened = openStore();
	const questions = [];
	const asked = (question) => { log.push("policy"); questions.push(question); return policy ? policy(question) : { allowed: true }; };
	await serve(topology, {
		store: recordingStore(opened.store, log),
		nameWriter: (caller) => { log.push("writer"); return nameWriter ? nameWriter(caller) : caller.evidence.node; },
		policy: asked,
	});
	const clients = Object.fromEntries(callers.map((c) => [c, clientOf(topology, c)]));
	return { topology, log, questions, clients, ...opened };
}

const position = (store) => store.historyBound().answer.position;

test("the policy is asked before each of the six operations, with the operation, the input, the caller's evidence, the writer named, the target and whether it is a recognised repeat", async (t) => {
	const { clients: { alice, bob }, questions } = await setup(t);
	const made = answerOf(await within(alice.create(note("alpha", ["t:x"]))));
	answerOf(await within(bob.update({ target: { kind: "note", name: "alpha" }, body: { summary: "two" } })));
	answerOf(await within(bob.read({ target: { id: "e1.1" } })));
	answerOf(await within(bob.findPage({ kind: "note", tags: ["t:x"] })));
	answerOf(await within(alice.historyBound()));
	answerOf(await within(alice.delete({ target: { id: "e1.1" }, expectedRevision: 2 })));
	assert.deepEqual(questions.map((q) => q.operation), ["create", "update", "read", "find", "history-bound", "delete"]);
	assert.deepEqual(questions.map((q) => q.input), [note("alpha", ["t:x"]), { target: { kind: "note", name: "alpha" }, body: { summary: "two" } }, { target: { id: "e1.1" } }, { kind: "note", tags: ["t:x"] }, {}, { target: { id: "e1.1" }, expectedRevision: 2 }]);
	assert.deepEqual(questions.map((q) => q.evidence), ["alice", "bob", "bob", "bob", "alice", "alice"].map((node) => ({ kind: "test-node", node })));
	assert.deepEqual(questions.map((q) => q.delivery.source.originNodeId), ["alice", "bob", "bob", "bob", "alice", "alice"]);
	assert.deepEqual(questions.map((q) => q.writer), ["alice", "bob", null, null, null, "alice"], "a writer is named for each write only");
	assert.deepEqual(questions.map((q) => q.target?.id ?? null), [null, "e1.1", null, null, null, "e1.1"], "an update's and a delete's target is resolved");
	assert.deepEqual(questions[1].target, made.entity, "the target is the entity as it stood when the policy ruled");
	assert.deepEqual(questions[5].target.revision, 2);
	assert.deepEqual(questions.map((q) => q.repeat), [false, false, false, false, false, false]);
	for (const q of questions) {
		assert.deepEqual(Object.keys(q).sort(), ["delivery", "evidence", "input", "operation", "repeat", "target", "writer"]);
		assert.ok(Object.isFrozen(q) && Object.isFrozen(q.input), "the question and its input are frozen, so the policy cannot change what the store is given");
		assert.ok(Object.isFrozen(q.evidence), "the evidence is frozen");
		if (q.target !== null) assert.ok(Object.isFrozen(q.target) && Object.isFrozen(q.target.body) && Object.isFrozen(q.target.created), "the target is frozen at every level");
	}
});

test("a write is handled in EM13's order: writer, retention and digest, target resolution, policy, store; a read is ruled on before the store answers", async (t) => {
	const { clients: { alice }, log } = await setup(t, { callers: ["alice"] });
	const steps = async (call) => { log.length = 0; await within(call()); return [...log]; };
	assert.deepEqual(await steps(() => alice.create(note("alpha"))), ["writer", "checkRepeat", "policy", "create"]);
	const renamed = await within(alice.update({ target: { id: "e1.1" }, name: "beta" }));
	assert.equal(renamed.ending, "answered");
	const invocation = renamed.invocation;
	assert.deepEqual(await steps(() => alice.update({ target: { id: "e1.1" }, name: "beta" }, { invocation, repeat: true })), ["writer", "checkRepeat", "policy"], "a recognised repeat: no target resolution, and no write");
	assert.deepEqual(await steps(() => alice.update({ target: { id: "e1.1" }, name: "gamma" }, { invocation })), ["writer", "checkRepeat", "read", "policy", "update"], "a reused identity: the target is resolved and the store refuses it");
	assert.deepEqual(await steps(() => alice.update({ target: { kind: "note", name: "beta" }, tags: ["a:b"] })), ["writer", "checkRepeat", "read", "policy", "update"]);
	assert.deepEqual(await steps(() => alice.delete({ target: { id: "e1.1" } })), ["writer", "checkRepeat", "read", "policy", "delete"]);
	assert.deepEqual(await steps(() => alice.read({ target: { id: "e1.1" } })), ["policy", "read"]);
	assert.deepEqual(await steps(() => alice.findPage({ kind: "note" })), ["policy", "find"]);
	assert.deepEqual(await steps(() => alice.find({ kind: "note" })), ["policy", "find"]);
	assert.deepEqual(await steps(() => alice.historyBound()), ["policy", "historyBound"]);
});

test("a recognised repeat is ruled on as one, and a reused identity as a fresh write whose target is resolved", async (t) => {
	const { clients: { alice }, questions } = await setup(t, { callers: ["alice"] });
	const first = await within(alice.create(note("alpha")));
	answerOf(await within(alice.create(note("alpha"), { invocation: first.invocation, repeat: true })));
	const update = await within(alice.update({ target: { id: "e1.1" }, name: "beta" }));
	const reused = await within(alice.update({ target: { id: "e1.1" }, name: "gamma" }, { invocation: update.invocation }));
	assert.equal(reused.refusal.code, "identity-reused");
	assert.deepEqual(questions.map((q) => [q.operation, q.repeat, q.target?.name ?? null]), [["create", false, null], ["create", true, null], ["update", false, "alpha"], ["update", false, "beta"]]);
});

test("no change lands between a ruling and its write: under concurrent writes from two callers, each write's ruling saw the revision it then wrote over", async (t) => {
	const { clients: { alice, bob }, questions } = await setup(t);
	answerOf(await within(alice.create({ kind: "any", name: "counter", tags: [], body: 0 })));
	const endings = await within(Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? alice : bob).update({ target: { kind: "any", name: "counter" }, body: i }))));
	const revisions = endings.map((e) => answerOf(e).entity.revision).sort((a, b) => a - b);
	assert.deepEqual(revisions, Array.from({ length: 12 }, (_, i) => i + 2));
	const ruled = questions.filter((q) => q.operation === "update");
	const written = new Map(endings.map((e) => [JSON.stringify(answerOf(e).entity.body), answerOf(e).entity.revision]));
	for (const q of ruled) assert.equal(written.get(JSON.stringify(q.input.body)), q.target.revision + 1, "the write took the revision after the one its ruling saw");
});

test("a denial is the policy's refusal, returned unchanged, for every operation, and no denial takes a position or reaches the store", async (t) => {
	const refusal = policyRefusal("not-writer", { writer: "somebody", nested: { list: [1, "two", null] } });
	let deny = false;
	const { clients: { alice }, store, log } = await setup(t, { callers: ["alice"], policy: () => deny ? { allowed: false, refusal } : { allowed: true } });
	answerOf(await within(alice.create(note("alpha"))));
	deny = true;
	log.length = 0;
	const endings = await within(Promise.all([
		alice.create(note("beta")), alice.update({ target: { id: "e1.1" }, name: "x" }), alice.delete({ target: { id: "e1.1" } }),
		alice.read({ target: { id: "e1.1" } }), alice.findPage({ kind: "note" }), alice.historyBound(),
	]));
	for (const e of endings) {
		assert.equal(e.ending, "refused", e.operation);
		assert.deepEqual(e.refusal, refusal, `${e.operation}: the refusal unchanged`);
	}
	assert.equal(position(store), 1, "no denial took a position");
	assert.deepEqual(log.filter((s) => ["create", "update", "delete", "read", "find", "historyBound"].includes(s)), ["read", "read"], "the store answered only the target resolutions, before the rulings");
	const whole = await within(alice.find({ kind: "note" }));
	assert.deepEqual([whole.ending, whole.refusal], ["refused", refusal], "a whole find ends refused as its page was");
});

test("zorg's rule as a fixture application: anyone creates and reads, only the writer updates or deletes, a target that does not exist is the store's to refuse, and a write with no writer named is refused", async (t) => {
	const { clients: { alice, bob, carol }, store } = await setup(t, {
		callers: ["alice", "bob", "carol"],
		policy: writerOnlyPolicy(),
		nameWriter: (caller) => caller.evidence.node === "carol" ? null : caller.evidence.node,
	});
	answerOf(await within(alice.create(note("alpha"))));
	answerOf(await within(bob.read({ target: { kind: "note", name: "alpha" } })), "anyone reads");
	for (const call of [() => bob.update({ target: { id: "e1.1" }, name: "stolen" }), () => bob.delete({ target: { kind: "note", name: "alpha" } })]) {
		const ending = await within(call());
		assert.equal(ending.ending, "refused");
		assert.deepEqual(ending.refusal, policyRefusal("not-writer", { writer: "alice" }));
	}
	const missing = await within(bob.update({ target: { id: "e9.1" }, name: "x" }));
	assert.deepEqual([missing.refusal.part, missing.refusal.code], ["entity-store", "not-found"], "the policy allows a target that does not exist; the store refuses it");
	const nobody = await within(carol.create(note("carols")));
	assert.deepEqual(nobody.refusal, policyRefusal("invalid-identity", { identity: null, node: "carol" }));
	answerOf(await within(carol.read({ target: { id: "e1.1" } })), "a read needs no writer");
	assert.equal(position(store), 1, "no denial took a position");
	assert.equal(answerOf(await within(alice.update({ target: { id: "e1.1" }, name: "renamed" }))).entity.changed.writer, "alice", "the writer updates");
	assert.equal(answerOf(await within(alice.delete({ target: { id: "e1.1" } }))).position, 3, "the writer deletes");
});

test("a repeated rename whose old name another agent has since taken is recognised before the target is resolved, so the policy rules on a repeat and the first answer returns", async (t) => {
	const questions = [];
	const { clients: { alice, bob }, store } = await setup(t, { policy: writerOnlyPolicy(questions) });
	answerOf(await within(alice.create(note("old"))));
	const input = { target: { kind: "note", name: "old" }, name: "new" };
	const first = await within(alice.update(input));
	answerOf(first);
	const bobs = answerOf(await within(bob.create(note("old"))));
	const repeat = await within(alice.update(input, { invocation: first.invocation, repeat: true }));
	assert.deepEqual(repeat.answer, first.answer, "the repeat returns the first answer");
	assert.equal(position(store), 3, "and takes no position");
	const asked = questions.at(-1);
	assert.deepEqual([asked.operation, asked.repeat, asked.target, asked.writer], ["update", true, null, "alice"]);
	assert.deepEqual(store.read({ target: { kind: "note", name: "old" } }).answer.entity, bobs.entity, "bob's entity is untouched");
	const fresh = await within(alice.update(input));
	assert.deepEqual(fresh.refusal, policyRefusal("not-writer", { writer: "bob" }), "the same rename under a new invocation is a fresh write, ruled on against bob's entity");
});

test("a policy that throws, rules with a promise, rules in another form or refuses with no refusal record ends the invocation unknown with operation-failed, and nothing is written", async (t) => {
	const rulings = [
		() => { throw new Error("policy broke"); },
		() => Promise.resolve({ allowed: true }),
		() => Promise.reject(new Error("a late rejection, consumed")),
		() => ({ allowed: "yes" }),
		() => null,
		() => ({ allowed: false }),
		() => ({ allowed: false, refusal: { code: "no" } }),
	];
	let which = 0;
	const { clients: { alice }, store } = await setup(t, { callers: ["alice"], policy: (q) => rulings[which](q) });
	for (which = 0; which < rulings.length; which++) {
		for (const call of [() => alice.create(note(`n${which}`)), () => alice.read({ target: { id: "e1.1" } })]) {
			const ending = await within(call());
			assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "operation-failed", null], `ruling ${which}, ${ending.operation}`);
		}
	}
	assert.equal(position(store), 0);
	await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a policy that allows a write for which the writer naming named no writer ends the invocation unknown, and nothing is written", async (t) => {
	const { clients: { alice }, store, questions } = await setup(t, { callers: ["alice"], nameWriter: () => null });
	const ending = await within(alice.create(note("alpha")));
	assert.deepEqual([ending.ending, ending.reason], ["unknown", "operation-failed"]);
	assert.deepEqual([questions[0].writer, questions[0].repeat], [null, false]);
	assert.equal(position(store), 0);
});

test("the input, the evidence and the target reach the policy as deeply frozen JSON snapshots: no change the policy tries reaches the store, the entity or a later request", async (t) => {
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const opened = openStore();
	const failures = [];
	const attempt = (what, change) => { try { change(); failures.push(`${what}: changed`); } catch (error) { failures.push(`${what}: ${error.constructor.name}`); } };
	const seen = [];
	await serve(topology, {
		store: opened.store,
		evidence: (delivery) => ({ kind: "test-node", node: delivery.source.originNodeId, session: { roles: ["writer"], since: 1 } }),
		policy: (q) => {
			seen.push(JSON.parse(JSON.stringify(q.evidence)));
			attempt("input", () => { q.input.body.summary = "forged"; });
			attempt("input tags", () => { q.input.tags.push("t:forged"); });
			attempt("evidence", () => { q.evidence.node = "mallory"; });
			attempt("nested evidence", () => { q.evidence.session.roles.push("admin"); });
			if (q.target !== null) {
				attempt("target", () => { q.target.created.writer = "mallory"; });
				attempt("nested target", () => { q.target.body.summary = "forged"; });
			}
			return { allowed: true };
		},
	});
	const alice = clientOf(topology, "alice");
	const made = answerOf(await within(alice.create(note("alpha", ["t:x"]))));
	assert.deepEqual([made.entity.body, made.entity.tags], [note("alpha").body, ["t:x"]], "the store was given the input as sent");
	const updated = answerOf(await within(alice.update({ target: { id: "e1.1" }, tags: ["t:y"], body: { summary: "two" } })));
	assert.deepEqual([updated.entity.created.writer, updated.entity.tags, updated.entity.body.summary], ["alice", ["t:y"], "two"], "the store was given the update as sent, over the entity as it stood");
	const frozen = ["input", "input tags", "evidence", "nested evidence"].map((f) => `${f}: TypeError`);
	assert.deepEqual(failures, [...frozen, ...frozen, "target: TypeError", "nested target: TypeError"], "every change the policy tried was refused by the freezing");
	assert.deepEqual(seen[1], { kind: "test-node", node: "alice", session: { roles: ["writer"], since: 1 } }, "a later request's evidence is its own, unchanged");
});

test("a refusal that is a promise, rejecting at once or later, ends the invocation unknown with operation-failed: its outcome is consumed, nothing is written, the host serves on, and no process-wide handler is installed", async (t) => {
	const handlers = process.listenerCount("unhandledRejection");
	const rejectLater = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("a refusal rejecting later")), 10));
	const rulings = [
		() => ({ allowed: false, refusal: Promise.reject(new Error("a refusal rejecting at once")) }),
		() => ({ allowed: false, refusal: rejectLater() }),
		() => ({ allowed: true, refusal: Promise.reject(new Error("an allowed ruling's promised refusal")) }),
		() => ({ allowed: false, refusal: Promise.resolve(policyRefusal("not-writer", {})) }),
	];
	let which = -1;
	const { clients: { alice }, store, log } = await setup(t, { callers: ["alice"], policy: (q) => (which < 0 ? { allowed: true } : rulings[which](q)) });
	for (which = 0; which < rulings.length; which++) {
		for (const call of [() => alice.create(note(`n${which}`)), () => alice.read({ target: { id: "e1.1" } })]) {
			const ending = await within(call());
			assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "operation-failed", null], `ruling ${which}, ${ending.operation}`);
		}
	}
	assert.equal(position(store), 0, "nothing was written");
	assert.ok(!log.includes("create") && !log.includes("read"), "the store was asked nothing but the repeat check");
	await new Promise((resolve) => setTimeout(resolve, 100));
	which = -1;
	assert.equal(answerOf(await within(alice.create(note("after")))).position, 1, "the host serves on");
	assert.equal(process.listenerCount("unhandledRejection"), handlers, "no process-wide rejection handler was left installed");
});

/**
 * Runs the host of policy-rejection-child.js over a set of its policy forms, in a process with no process-wide
 * rejection handler, and asserts every case of it: operation-failed, nothing written, the host serving the
 * next request; a rejection escaping ends the child before it writes its result. No piped stdio.
 */
async function rejectionChild(t, set, forms) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-api-policy-rejection-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const resultFile = path.join(dir, "result.json");
	const errors = fs.openSync(path.join(dir, "stderr.txt"), "w");
	const child = spawn(process.execPath, ["--unhandled-rejections=throw", fileURLToPath(new URL("../support/policy-rejection-child.js", import.meta.url)), resultFile, set],
		{ stdio: ["ignore", errors, errors], env: { ...process.env, NODE_OPTIONS: undefined, NODE_TEST_CONTEXT: undefined } });
	const [code, signal] = await within(once(child, "exit"), "the child's exit");
	fs.closeSync(errors);
	const stderr = fs.readFileSync(path.join(dir, "stderr.txt"), "utf8");
	assert.deepEqual([code, signal], [0, null], `the child ran to its end, no rejection escaping: ${stderr}`);
	const { cases, handlers } = JSON.parse(fs.readFileSync(resultFile, "utf8"));
	assert.equal(handlers, 0, "the child installed no process-wide rejection handler");
	assert.equal(cases.length, forms.length * 4, `${forms.length} forms, two timings, a create and a read`);
	for (const [i, c] of cases.entries()) {
		const what = `${c.form}, rejecting ${c.timing}, ${c.operation}`;
		assert.deepEqual(c.ending, ["unknown", "operation-failed", null], what);
		assert.equal(c.written, false, `${what}: nothing written`);
		assert.deepEqual([c.next, c.nextPosition], ["answered", c.positionBefore + 1], `${what}: the host serves the next request`);
		assert.equal(c.positionBefore, i, `${what}: only the requests served took a position`);
	}
	assert.deepEqual([...new Set(cases.map((c) => c.form))], forms);
}

test("a promise as the ruling's allowed, or within its refusal, rejecting at once or later, for a create and a read, ends the invocation unknown with operation-failed, its outcome consumed, nothing written, and the host serving on, in a process with no rejection handler", async (t) => {
	await rejectionChild(t, "promised", ["allowed", "within the refusal", "allowed and within the refusal"]);
});

test("a promise met before a getter that throws - the ruling's allowed before its refusal, a nested refusal object's member or a refusal array member before the next - rejecting at once or later, for a create and a read, ends the invocation unknown with operation-failed, its outcome consumed, nothing written, and the host serving on, in a process with no rejection handler", async (t) => {
	await rejectionChild(t, "met before a throwing getter", ["allowed, then a throwing refusal", "a nested refusal object's member, then a throwing member", "a refusal array member, then a throwing member"]);
});

test("each policy form of stage 5's fourth verification, its promises rejecting at once or later, for a create and a read, ends the invocation unknown with operation-failed, no getter run, every promise consumed, nothing written, and the host serving on, in a process with no rejection handler", async (t) => {
	await rejectionChild(t, "fourth verification", ["a ruling's then getter giving a rejecting promise", "a refusal member's non-enumerable then getter giving a rejecting promise", "a refusal member's throwing getter before a then getter giving a rejecting promise", "a rejecting promise as a ruling's own then data property", "a rejecting promise as a ruling's non-enumerable then data property", "a rejecting promise hidden in a refusal member's non-enumerable data property"]);
});

/** A refusal of EM9's form, its details a fresh object each time. */
const declined = (details = {}) => ({ part: "application", code: "declined", what: "Declined", why: "Application rule", fix: "Ask owner", details });

test("a plain ruling is taken as read: { allowed: true } and { allowed: false, refusal }, in either key order and with null prototypes, data named then kept, the refusal passed on as it was when read, deeply frozen, whatever the policy does to it later", async (t) => {
	const nullProto = (fields) => Object.assign(Object.create(null), fields);
	const kept = declined({ then: "kept as data", list: [1, { then: null }] });
	const passedOn = [];
	const RULINGS = [
		["allowed", () => ({ allowed: true }), null],
		["allowed, a null prototype", () => nullProto({ allowed: true }), null],
		["refused", () => ({ allowed: false, refusal: declined({ n: 1 }) }), declined({ n: 1 })],
		["refused, refusal first", () => ({ refusal: declined(), allowed: false }), declined()],
		["refused, null prototypes", () => nullProto({ allowed: false, refusal: nullProto({ ...declined(), details: nullProto({ deep: nullProto({ x: 1 }) }) }) }), declined({ deep: { x: 1 } })],
		["refused, data named then", () => ({ allowed: false, refusal: declined({ then: "kept as data", list: [1, { then: null }] }) }), kept],
		["refused with misfits", () => ({ allowed: false, refusal: { ...declined(), misfits: [{ pointer: "", keyword: "type", expected: "object", fit: "a value of the declared shape" }] } }), { ...declined(), misfits: [{ pointer: "", keyword: "type", expected: "object", fit: "a value of the declared shape" }] }],
		["refused, changed by the policy once ruled", () => {
			const refusal = declined({ n: 2 });
			queueMicrotask(() => { refusal.what = "changed"; refusal.details.n = 3; });
			return { allowed: false, refusal };
		}, declined({ n: 2 })],
	];
	let ruling = () => ({ allowed: true });
	const { clients: { alice }, store } = await setup(t, { callers: ["alice"], policy: () => {
		const answer = ruling();
		passedOn.push(answer);
		return answer;
	} });
	let made = 0;
	for (const [what, rule, refusal] of RULINGS) {
		for (const operation of ["create", "read"]) {
			ruling = rule;
			const before = position(store);
			const ending = await within(operation === "create" ? alice.create(note(`p${made++}`)) : alice.read({ target: { id: "e1.1" } }));
			if (refusal === null) {
				assert.equal(ending.ending, "answered", `${what}, ${operation}`);
				assert.equal(position(store), before + (operation === "create" ? 1 : 0), `${what}, ${operation}: written as allowed`);
			} else {
				assert.deepEqual([ending.ending, ending.refusal], ["refused", refusal], `${what}, ${operation}: the refusal passed on as it was read`);
				assert.equal(position(store), before, `${what}, ${operation}: nothing written`);
			}
		}
	}
});

test("the ruling is read as plain data, running none of its code: every form of stage 5's fourth verification - a then getter throwing, enumerable or not, on the ruling, its refusal or a refusal member, a then getter giving a rejected promise on the ruling or a refusal member, a getter that throws before it - and a then getter giving a function, a getter of allowed or refusal, a promise as own then data, enumerable or not, or hidden in non-enumerable data, a class instance, an inherited, symbol, non-enumerable or extra field, an invalid EM9 refusal, a value that is no object, and a Proxy whose traps throw, each end the invocation unknown with operation-failed: no getter runs, every promise met is observed, nothing is written, no rejection goes unhandled, and the host serves on", async (t) => {
	const escaped = [];
	const onUnhandled = (reason) => { escaped.push(reason); };
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	const ran = [];
	const getter = (what, gives) => function () { ran.push(what); return gives(); };
	const throws = () => { throw new Error("policy member reading"); };
	const rejected = () => Promise.reject(new Error("policy member outcome"));
	const thenable = () => (onFulfilled, onRejected) => { ran.push("thenable called"); return rejected().then(onFulfilled, onRejected); };
	const withGetter = (object, name, gives, enumerable = true) => Object.defineProperty(object, name, { get: getter(name, gives), enumerable, configurable: true });
	const withData = (object, name, value, enumerable = true) => Object.defineProperty(object, name, { value, enumerable, writable: true, configurable: true });
	class Ruling { constructor() { this.allowed = true; } }
	const FORMS = {
		// The eight forms of the fourth verification's policy-answer-reading probe, but its ordinary control.
		"a ruling's enumerable then getter throwing": () => withGetter({ allowed: true }, "then", throws),
		"a refusal's enumerable then getter throwing": () => ({ allowed: false, refusal: withGetter(declined(), "then", throws) }),
		"a refusal's non-enumerable then getter throwing": () => ({ allowed: false, refusal: withGetter(declined(), "then", throws, false) }),
		"a refusal member's non-enumerable then getter throwing": () => ({ allowed: false, refusal: declined({ member: withGetter({ kept: 1 }, "then", throws, false) }) }),
		"a ruling's then getter giving a rejected promise": () => withGetter({ allowed: true }, "then", rejected),
		"a refusal member's non-enumerable then getter giving a rejected promise": () => ({ allowed: false, refusal: declined({ member: withGetter({ kept: 1 }, "then", rejected, false) }) }),
		"a refusal member's getter throwing before a then getter giving a rejected promise": () => ({ allowed: false, refusal: declined({ member: withGetter(withGetter({}, "before", throws), "then", rejected) }) }),
		// Beyond them.
		"a ruling's then getter giving a function": () => withGetter({ allowed: true }, "then", thenable),
		"a ruling's non-enumerable then getter giving a function": () => withGetter({ allowed: true }, "then", thenable, false),
		"a refusal's then getter giving a function": () => ({ allowed: false, refusal: withGetter(declined(), "then", thenable) }),
		"a getter of allowed": () => withGetter({}, "allowed", () => true),
		"a getter of refusal": () => withGetter({ allowed: false }, "refusal", () => declined()),
		"a rejected promise as allowed": () => ({ allowed: rejected() }),
		"a rejected promise as a ruling's own then data": () => withData({ allowed: true }, "then", rejected()),
		"a rejected promise as a ruling's non-enumerable then data": () => withData({ allowed: true }, "then", rejected(), false),
		"a rejected promise hidden in a refusal member's non-enumerable data": () => ({ allowed: false, refusal: declined({ member: withData({ kept: 1 }, "hidden", { deep: [rejected()] }, false) }) }),
		"a rejected promise beside a throwing getter in a refusal array": () => ({ allowed: false, refusal: declined({ list: withGetter([rejected(), 0], "1", throws) }) }),
		"a ruling's non-enumerable allowed": () => withData({}, "allowed", true, false),
		"a class instance": () => new Ruling(),
		"an inherited allowed": () => Object.create({ allowed: true }),
		"a symbol beside allowed": () => ({ allowed: true, [Symbol("extra")]: 1 }),
		"an extra field beside allowed": () => ({ allowed: true, why: "because" }),
		"a refusal beside allowed true": () => ({ allowed: true, refusal: declined() }),
		"an extra field beside a refusal": () => ({ allowed: false, refusal: declined(), why: "because" }),
		"no refusal": () => ({ allowed: false }),
		"a refusal missing why": () => ({ allowed: false, refusal: (({ why, ...rest }) => rest)(declined()) }),
		"a refusal with an empty code": () => ({ allowed: false, refusal: { ...declined(), code: "" } }),
		"a refusal with an extra field": () => ({ allowed: false, refusal: { ...declined(), extra: 1 } }),
		"a refusal whose details are a list": () => ({ allowed: false, refusal: { ...declined(), details: [] } }),
		"a refusal with no misfits listed": () => ({ allowed: false, refusal: { ...declined(), misfits: [] } }),
		"an Error as the refusal": () => ({ allowed: false, refusal: Object.assign(new Error("declined"), declined()) }),
		"a refusal holding undefined": () => ({ allowed: false, refusal: declined({ missing: undefined }) }),
		"a ruling holding itself": () => { const ruling = { allowed: false, refusal: declined() }; ruling.refusal.details.self = ruling; return ruling; },
		"a list": () => [true],
		"a string": () => "allowed",
		"undefined": () => undefined,
		"a Proxy whose traps throw": () => new Proxy({ allowed: true }, Object.fromEntries(["get", "getOwnPropertyDescriptor", "ownKeys", "getPrototypeOf", "has"].map((trap) => [trap, () => { ran.push(`${trap} trap`); throw new Error("a trap that throws"); }]))),
	};
	// Traps the reader runs without running any code of the application's own: listing keys and the prototype.
	const READER_TRAPS = new Set(["ownKeys trap", "getPrototypeOf trap", "getOwnPropertyDescriptor trap"]);
	let ruling = () => ({ allowed: true });
	const { clients: { alice }, store, log } = await setup(t, { callers: ["alice"], policy: () => ruling() });
	for (const [what, rule] of Object.entries(FORMS)) {
		for (const operation of ["create", "read"]) {
			ran.length = 0;
			log.length = 0;
			ruling = rule;
			const ending = await within(operation === "create" ? alice.create(note("alpha")) : alice.read({ target: { id: "e1.1" } }));
			assert.deepEqual([ending.ending, ending.reason, ending.agpCode], ["unknown", "operation-failed", null], `${what}, ${operation}`);
			assert.deepEqual(ran.filter((r) => !READER_TRAPS.has(r)), [], `${what}, ${operation}: no getter, function or get trap run`);
			assert.ok(!log.includes("create") && !log.includes("read"), `${what}, ${operation}: the store neither written nor read`);
		}
	}
	assert.equal(position(store), 0, "nothing was written");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(escaped, [], "no rejection went unhandled");
	ruling = () => ({ allowed: true });
	assert.equal(answerOf(await within(alice.create(note("after")))).position, 1, "the host serves on");
});

test("describe, operation-call's own operation, is ruled on by no policy and names no writer", async (t) => {
	const { topology, log } = await setup(t, { callers: ["alice"] });
	log.length = 0;
	const ending = await within(topology.caller("alice").caller.invoke({ host: "host-a", service: "store", operation: "describe", input: {}, bound: 5000 }));
	assert.equal(answerOf(ending).service, "store");
	assert.deepEqual(log, [], "neither the policy, the writer naming nor the store was asked");
});

test("a retained write identity with another digest is no recognised repeat: the policy rules on it as a fresh write, and its denial wins over the store's identity-reused", async (t) => {
	const refusal = policyRefusal("not-writer", { writer: "somebody" });
	let deny = false;
	const { clients: { alice }, store, log, questions } = await setup(t, { callers: ["alice"], policy: () => (deny ? { allowed: false, refusal } : { allowed: true }) });
	const made = await within(alice.create(note("alpha")));
	answerOf(made);
	deny = true;
	log.length = 0;
	const denied = await within(alice.update({ target: { id: "e1.1" }, name: "beta" }, { invocation: made.invocation }));
	assert.deepEqual([denied.ending, denied.refusal], ["refused", refusal], "the policy's refusal, not identity-reused");
	assert.deepEqual(log, ["writer", "checkRepeat", "read", "policy"], "the target was resolved, the policy ruled, and the store was not written");
	assert.deepEqual([questions.at(-1).repeat, questions.at(-1).target.name], [false, "alpha"]);
	assert.equal(position(store), 1, "no position taken");
	deny = false;
	const allowed = await within(alice.update({ target: { id: "e1.1" }, name: "beta" }, { invocation: made.invocation }));
	assert.deepEqual([allowed.refusal.part, allowed.refusal.code], ["entity-store", "identity-reused"], "allowed, the write meets the store's identity-reused");
});
