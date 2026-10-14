// callback-fault-checks - the contract tests' runs of callback-faults.js, in the test's own process and in a
// child process with no process-wide rejection handler, and the assertions each case must meet (zorg's target,
// EM13; stage 5's fifth verification, F1 and F2).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTopology, within } from "./topology.js";
import { clientOf, openStore, serve } from "./serving.js";
import { formsOf, OPERATIONS, runFaults, switchable } from "./callback-faults.js";

/**
 * Asserts every case: unknown with operation-failed, nothing written, none of the answer's code run, only the
 * requests served having taken a position - the first fault meeting position 0 - and the host serving the next.
 */
function checkCases(set, cases) {
	const forms = Object.keys(formsOf(set, []));
	assert.equal(cases.length, forms.length * 2 * OPERATIONS[set].length, `${forms.length} forms, two timings, ${OPERATIONS[set].join(" and ")}`);
	assert.deepEqual([...new Set(cases.map((c) => c.form))], forms);
	for (const [i, c] of cases.entries()) {
		const what = `${set}: ${c.form}, rejecting ${c.timing}, ${c.operation}`;
		assert.deepEqual(c.ending, ["unknown", "operation-failed", null], what);
		assert.equal(c.written, false, `${what}: nothing written`);
		assert.equal(c.codeRun, 0, `${what}: no getter or thenable of the answer run`);
		assert.equal(c.positionBefore, i, `${what}: only the requests served took a position`);
		assert.deepEqual([c.next, c.nextPosition], ["answered", c.positionBefore + 1], `${what}: the host serves the next request`);
	}
	assert.equal(cases[0].positionBefore, 0, "the first fault met position 0");
}

/** Runs a set of forms in the test's process, counting rejections that go unhandled: there must be none. */
export async function faultsInProcess(t, set) {
	const escaped = [];
	const onUnhandled = (reason) => { escaped.push(reason); };
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	const topology = await openTopology({ callers: ["alice"] });
	t.after(() => topology.close());
	const { store } = openStore();
	const { state, evidence, nameWriter, policy } = switchable();
	await serve(topology, { store, evidence, nameWriter, policy });
	const cases = await within(runFaults({ set, client: clientOf(topology, "alice"), store, state, ran: [] }), "the faults' run");
	await new Promise((resolve) => setTimeout(resolve, 50));
	checkCases(set, cases);
	assert.deepEqual(escaped, [], "no rejection went unhandled");
}

/** Runs a set of forms in a child process with no process-wide rejection handler; a rejection escaping ends it. */
export async function faultsInChild(t, set) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entity-api-callback-fault-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const resultFile = path.join(dir, "result.json");
	const errors = fs.openSync(path.join(dir, "stderr.txt"), "w");
	const child = spawn(process.execPath, ["--unhandled-rejections=throw", fileURLToPath(new URL("./callback-fault-child.js", import.meta.url)), resultFile, set],
		{ stdio: ["ignore", errors, errors], env: { ...process.env, NODE_OPTIONS: undefined, NODE_TEST_CONTEXT: undefined } });
	const [code, signal] = await within(once(child, "exit"), "the child's exit");
	fs.closeSync(errors);
	const stderr = fs.readFileSync(path.join(dir, "stderr.txt"), "utf8");
	assert.deepEqual([code, signal], [0, null], `the child ran to its end, no rejection escaping: ${stderr}`);
	const { cases, handlers } = JSON.parse(fs.readFileSync(resultFile, "utf8"));
	assert.equal(handlers, 0, "the child installed no process-wide rejection handler");
	checkCases(set, cases);
}
