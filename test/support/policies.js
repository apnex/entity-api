// policies - fixture applications for the host half's tests: a policy with zorg's rule (zorg's D25 and
// EM13: a write needs a named writer; anyone may create, read, find and read the bound; only an entity's
// writer may update or delete it, unless the target does not exist or the write is a recognised repeat),
// written here as a fixture application of its own, and a store wrapper that records, in one log with the
// application's own steps, every call the host half makes of the store.

/** A refusal record of the fixture policy, in EM9's form. */
export function policyRefusal(code, details) {
	return {
		part: "fixture-policy",
		code,
		what: code === "invalid-identity" ? "The request's evidence names no writer." : "The entity was written by another caller.",
		why: code === "invalid-identity" ? "A change needs a writer to record." : "Only an entity's writer may change it.",
		fix: code === "invalid-identity" ? "Call with an identity the host can name." : "Ask the entity's writer to make the change.",
		details,
	};
}

/** zorg's rule as a fixture policy; `log`, when given, receives every question asked. */
export function writerOnlyPolicy(log = []) {
	return (question) => {
		log.push(question);
		const { operation, writer, target, repeat, evidence } = question;
		const writes = operation === "create" || operation === "update" || operation === "delete";
		if (writes && writer === null) return { allowed: false, refusal: policyRefusal("invalid-identity", { identity: null, node: evidence?.node ?? null }) };
		if (operation === "update" || operation === "delete") {
			if (repeat || target === null || target.created.writer === writer) return { allowed: true };
			return { allowed: false, refusal: policyRefusal("not-writer", { writer: target.created.writer }) };
		}
		return { allowed: true };
	};
}

/** Wraps a store so every call the host half makes of it is pushed to `log` as its method name, then made. */
export function recordingStore(store, log) {
	const wrapped = {};
	for (const method of ["create", "update", "delete", "read", "find", "historyBound", "changes", "follow", "waitForChange", "checkRepeat"]) {
		wrapped[method] = (...args) => { log.push(method); return store[method](...args); };
	}
	return wrapped;
}
