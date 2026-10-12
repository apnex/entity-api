// policy-rejection-child - a host serving a store whose policy rules with promises that reject, run as its own
// process with no process-wide rejection handler, so a rejection escaping to the runtime ends the process
// (zorg's target, EM13; ask-application-policy).
//
// For each case - a promise as the ruling's `allowed`, two promises within its refusal, and both at once; each
// rejecting at once or later; each for a create and for a read - it calls the host, waits long enough for a
// later rejection to have happened, and then calls again under a policy that allows. It writes what it saw,
// as JSON, to the file it is given, and exits 0; a rejection that escaped ends it first, with no file written.
// The parent reads only that file and the exit code: no piped stdio.
import fs from "node:fs";
import { openTopology } from "./topology.js";
import { clientOf, note, openStore, serve } from "./serving.js";
import { policyRefusal } from "./policies.js";

const [resultFile] = process.argv.slice(2);
if (!resultFile) throw new Error("policy-rejection-child needs the file to write its result to");

/** A promise rejecting now, or 10 ms from now on the real clock. */
const rejecting = (timing, what) => (timing === "at once"
	? Promise.reject(new Error(`${what}, rejecting at once`))
	: new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${what}, rejecting later`)), 10)));

/** The policy's ruling for each form, its promises made as it rules. */
const FORMS = {
	"allowed": (timing) => ({ allowed: rejecting(timing, "allowed") }),
	"within the refusal": (timing) => ({ allowed: false, refusal: policyRefusal("not-writer", { first: rejecting(timing, "first within the refusal"), checks: [1, { pending: rejecting(timing, "within the refusal") }] }) }),
	"allowed and within the refusal": (timing) => ({ allowed: rejecting(timing, "allowed"), refusal: policyRefusal("not-writer", { pending: rejecting(timing, "within the refusal") }) }),
};

const topology = await openTopology({ callers: ["alice"] });
const cases = [];
try {
	const { store } = openStore();
	let ruling = () => ({ allowed: true });
	await serve(topology, { store, policy: () => ruling() });
	const client = clientOf(topology, "alice");
	const position = () => store.historyBound().answer.position;
	let made = 0;
	for (const [form, rule] of Object.entries(FORMS)) {
		for (const timing of ["at once", "later"]) {
			for (const operation of ["create", "read"]) {
				const before = position();
				ruling = () => rule(timing);
				const ending = operation === "create" ? await client.create(note(`n${made}`)) : await client.read({ target: { kind: "note", name: "n0" } });
				const after = position();
				// Long past the 10 ms a later rejection waits: timers run in order, so it has happened by then.
				await new Promise((resolve) => setTimeout(resolve, 100));
				ruling = () => ({ allowed: true });
				const next = await client.create(note(`served${made++}`));
				cases.push({ form, timing, operation, ending: [ending.ending, ending.reason, ending.agpCode], written: after !== before, next: next.ending, nextPosition: next.answer?.position ?? null, positionBefore: before });
			}
		}
	}
} finally {
	await topology.close();
}
fs.writeFileSync(resultFile, JSON.stringify({ cases, handlers: process.listenerCount("unhandledRejection") }));
