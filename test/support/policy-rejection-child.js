// policy-rejection-child - a host serving a store whose policy rules with promises that reject, run as its own
// process with no process-wide rejection handler, so a rejection escaping to the runtime ends the process
// (zorg's target, EM13; ask-application-policy).
//
// For each case of the set of forms it is given - "promised": a promise as the ruling's `allowed`, two promises
// within its refusal, and both at once; "met before a throwing getter": a promise read and then a getter that
// throws, at the ruling's top level, in a nested refusal object and in a refusal array; "fourth verification":
// the forms of stage 5's fourth verification whose promises went unhandled, and promises in own data properties
// named then or hidden as non-enumerable, which the plain-data reader observes without running any getter
// (zorg's D54, D55); each rejecting at once or later; each for a create and for a read - it calls the host,
// waits long enough for a
// later rejection to have happened, and then calls again under a policy that allows. It writes what it saw,
// as JSON, to the file it is given, and exits 0; a rejection that escaped ends it first, with no file written.
// The parent reads only that file and the exit code: no piped stdio.
import fs from "node:fs";
import { openTopology } from "./topology.js";
import { clientOf, note, openStore, serve } from "./serving.js";
import { policyRefusal } from "./policies.js";

const [resultFile, set = "promised"] = process.argv.slice(2);
if (!resultFile) throw new Error("policy-rejection-child needs the file to write its result to");

/** A promise rejecting now, or 10 ms from now on the real clock. */
const rejecting = (timing, what) => (timing === "at once"
	? Promise.reject(new Error(`${what}, rejecting at once`))
	: new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${what}, rejecting later`)), 10)));

/** A getter that throws, read after a promise has been read. */
const throwing = () => { throw new Error("a getter read after a promise, throwing"); };

/** The policy's ruling for each form, its promises made as it rules. */
const PROMISED = {
	"allowed": (timing) => ({ allowed: rejecting(timing, "allowed") }),
	"within the refusal": (timing) => ({ allowed: false, refusal: policyRefusal("not-writer", { first: rejecting(timing, "first within the refusal"), checks: [1, { pending: rejecting(timing, "within the refusal") }] }) }),
	"allowed and within the refusal": (timing) => ({ allowed: rejecting(timing, "allowed"), refusal: policyRefusal("not-writer", { pending: rejecting(timing, "within the refusal") }) }),
};

/**
 * The policy's ruling for each form in which a promise is read and then a getter throws (EM13): at the ruling's
 * top level, the `allowed` read before a throwing `refusal`; in a nested refusal object, one member before a
 * throwing one; and in a refusal array, one member before a throwing one.
 */
const MET_BEFORE_A_THROWING_GETTER = {
	"allowed, then a throwing refusal": (timing) => ({ get allowed() { return rejecting(timing, "allowed"); }, get refusal() { return throwing(); } }),
	"a nested refusal object's member, then a throwing member": (timing) => ({ allowed: false, refusal: policyRefusal("not-writer", { nested: { get first() { return rejecting(timing, "nested member"); }, get second() { return throwing(); } } }) }),
	"a refusal array member, then a throwing member": (timing) => {
		const list = [rejecting(timing, "array member"), 0];
		Object.defineProperty(list, 1, { get: throwing, enumerable: true });
		return { allowed: false, refusal: policyRefusal("not-writer", { list }) };
	},
};

/** A refusal record of EM9's form. */
const declined = (details = {}) => ({ part: "application", code: "declined", what: "Declined", why: "Application rule", fix: "Ask owner", details });

/** The forms of stage 5's fourth verification whose promises went unhandled, and promises in data the reader observes. */
const FOURTH_VERIFICATION = {
	"a ruling's then getter giving a rejecting promise": (timing) => ({ allowed: true, get then() { return rejecting(timing, "a ruling's then"); } }),
	"a refusal member's non-enumerable then getter giving a rejecting promise": (timing) => ({ allowed: false, refusal: declined({ member: Object.defineProperty({ kept: 1 }, "then", { get: () => rejecting(timing, "a member's then") }) }) }),
	"a refusal member's throwing getter before a then getter giving a rejecting promise": (timing) => ({ allowed: false, refusal: declined({ member: { get before() { return throwing(); }, get then() { return rejecting(timing, "a member's then"); } } }) }),
	"a rejecting promise as a ruling's own then data property": (timing) => ({ allowed: true, then: rejecting(timing, "a ruling's then data") }),
	"a rejecting promise as a ruling's non-enumerable then data property": (timing) => Object.defineProperty({ allowed: true }, "then", { value: rejecting(timing, "a ruling's hidden then data") }),
	"a rejecting promise hidden in a refusal member's non-enumerable data property": (timing) => ({ allowed: false, refusal: declined({ member: Object.defineProperty({ kept: 1 }, "hidden", { value: [rejecting(timing, "hidden data")] }) }) }),
};

const FORMS = { "promised": PROMISED, "met before a throwing getter": MET_BEFORE_A_THROWING_GETTER, "fourth verification": FOURTH_VERIFICATION }[set];
if (!FORMS) throw new Error(`policy-rejection-child has no set of forms ${set}`);

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
