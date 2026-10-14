// callback-faults - the faults of stage 5's fifth verification, made by the application's callbacks, and the run
// of them against a served store (zorg's target, EM13; zorg's D54, D55; peer-identity-evidence,
// ask-application-policy, host-named-writer).
//
// "thrown" (F2): the policy, the writer naming or the evidence function throws a native promise that rejects,
// a plain object holding one, or an Error whose cause is one - the promise rejecting at once or later. Every
// thrown value has its promises observed by entity-api before operation-call's host drops it.
//
// "evidence returned" (F1): the evidence function answers, synchronously, evidence with a top-level then getter
// giving undefined or giving a rejecting promise, or a non-native thenable resolving to plain evidence; or,
// asynchronously, a native promise rejecting, or a native promise resolving to evidence holding a rejecting
// promise. None of it is awaited as it is: entity-api reads a synchronous answer as plain data before the
// host awaits it, so no then getter or thenable runs, and follows only a native promise.
//
// Each form, each timing and each operation ends the invocation unknown with operation-failed, writes
// nothing, runs no code of the answer, and is followed by a request the host serves.

/** A promise rejecting now, or 10 ms from now on the real clock. */
export const rejecting = (timing, what) => (timing === "at once"
	? Promise.reject(new Error(`${what}, rejecting at once`))
	: new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${what}, rejecting later`)), 10)));

/** The values a callback throws (F2), each holding a promise that rejects with the timing given. */
const THROWN = {
	"a rejected promise": (timing, what) => rejecting(timing, `${what} throwing a promise`),
	"a plain object holding a rejected promise": (timing, what) => ({ reason: "declined", pending: rejecting(timing, `${what} throwing an object holding a promise`) }),
	"an Error caused by a rejected promise": (timing, what) => new Error(`${what} failed`, { cause: rejecting(timing, `${what} throwing an Error caused by a promise`) }),
};

/** The set of forms for a callback: what it does in place of the application's ordinary callback. */
export function formsOf(set, ran) {
	if (set === "policy" || set === "nameWriter" || set === "evidence") {
		return Object.fromEntries(Object.entries(THROWN).map(([form, thrown]) => [form, (timing) => ({ [set]: () => { throw thrown(timing, set); } })]));
	}
	if (set === "evidence returned") {
		return {
			"a top-level then getter giving undefined": () => ({ evidence: () => ({ node: "alice", principal: "alice", get then() { ran.push("then getter"); return undefined; } }) }),
			"a top-level then getter giving a rejecting promise": (timing) => ({ evidence: () => ({ node: "alice", principal: "alice", get then() { ran.push("then getter"); return rejecting(timing, "a then getter's promise"); } }) }),
			"a non-native thenable resolving to plain evidence": () => ({ evidence: () => ({ then(resolve) { ran.push("thenable called"); resolve({ node: "alice", principal: "alice" }); } }) }),
			"a non-enumerable then getter": () => ({ evidence: () => Object.defineProperty({ node: "alice" }, "then", { get() { ran.push("then getter"); return undefined; } }) }),
			"a native promise rejecting": (timing) => ({ evidence: () => rejecting(timing, "the evidence's promise") }),
			"a native promise resolving to evidence holding a rejecting promise": (timing) => ({ evidence: () => Promise.resolve({ node: "alice", pending: rejecting(timing, "a promise within the evidence") }) }),
		};
	}
	throw new Error(`callback-faults has no set of forms ${set}`);
}

/** The operations each set's faults are met by: the writer naming is asked for writes only. */
export const OPERATIONS = { policy: ["create", "read"], nameWriter: ["create", "delete"], evidence: ["create", "read"], "evidence returned": ["create", "read"] };

/**
 * Callbacks for serveStore that do as `mode` says, when it says, and otherwise as the tests' ordinary ones do:
 * evidence naming the origin node, the writer it names, and a policy that allows.
 */
export function switchable() {
	const state = { mode: {} };
	return {
		state,
		evidence: (delivery) => (state.mode.evidence ? state.mode.evidence(delivery) : { kind: "test-node", node: delivery.source.originNodeId }),
		nameWriter: (caller) => (state.mode.nameWriter ? state.mode.nameWriter(caller) : caller.evidence.node),
		policy: (question) => (state.mode.policy ? state.mode.policy(question) : { allowed: true }),
	};
}

/**
 * Runs every form of a set, each rejecting at once and later, for each of the set's operations, against a
 * served store: the faulty call, a wait long past a later rejection, then a request the host must serve.
 */
export async function runFaults({ set, client, store, state, ran }) {
	const position = () => store.historyBound().answer.position;
	const cases = [];
	let made = 0;
	for (const [form, make] of Object.entries(formsOf(set, ran))) {
		for (const timing of ["at once", "later"]) {
			for (const operation of OPERATIONS[set]) {
				const before = position();
				ran.length = 0;
				state.mode = make(timing);
				const ending = operation === "create" ? await client.create({ kind: "note", name: `n${made}`, tags: [], body: { pointer: `https://example.com/n${made}`, summary: "a note" } })
					: operation === "delete" ? await client.delete({ target: { id: "e1.1" } })
					: await client.read({ target: { id: "e1.1" } });
				const after = position();
				const codeRun = ran.length;
				// Long past the 10 ms a later rejection waits: timers run in order, so it has happened by then.
				await new Promise((resolve) => setTimeout(resolve, 100));
				state.mode = {};
				const next = await client.create({ kind: "note", name: `served${made++}`, tags: [], body: { pointer: "https://example.com/served", summary: "served" } });
				cases.push({ form, timing, operation, ending: [ending.ending, ending.reason ?? null, ending.agpCode ?? null], written: after !== before, codeRun, next: next.ending, nextPosition: next.answer?.position ?? null, positionBefore: before });
			}
		}
	}
	return cases;
}
