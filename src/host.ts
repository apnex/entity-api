/**
 * The host half (zorg's target, EM7, EM10, EM13): serve one store's operations as named operations, under a
 * name the application chooses, through operation-call's host, asking the application's policy before each
 * operation and recording the writer the application names from the caller's evidence.
 *
 * operation-call's host judges each input against EM10's shape before an operation runs, so an input carrying
 * a writer or a write identity is refused as `input-misfit` and nothing here is asked. A write is then handled
 * in one synchronous step, so no change lands between a ruling and its write (EM13):
 *
 * 1. the application names the writer from the request's evidence - never from the input;
 * 2. the store says whether the write identity - the invocation identity from operation-call's envelope,
 *    never from the input (EM7) - is retained, and whether the digest matches;
 * 3. unless the write is a recognised repeat, the target of an update or delete is resolved to the entity it
 *    names, if any;
 * 4. the application's policy rules, given the operation, the input, the caller's evidence, the writer
 *    named, the target and whether the write is a recognised repeat;
 * 5. a refusal is returned unchanged; a recognised repeat returns the first answer; any other write goes to
 *    the store, whose answer or refusal is returned unchanged.
 *
 * A read, a find and `history-bound` are ruled on by the policy before the store answers them. entity-api
 * decides nothing itself: it never refuses for its own reasons, and owns no refusal code. The caller's
 * evidence, the writer's name and the policy's ruling and refusal are read as plain data through shape-check's
 * `plain-json-value` and operation-call's `readRefusalRecord`, running none of their code (zorg's D54, D55).
 * Nothing here is particular to one runtime (zorg's D31).
 */
import type { AgpNode } from "@agp/node";
import type { EntityEnvelope, EntityStore, RepeatCheck, StoreOutcome, WriteContext } from "@apnex/entity-store";
import {
	createOperationHost,
	type DeliveryContext,
	type Description,
	type EvidenceFunction,
	type HostRefusal,
	type JsonValue,
	type OperationContext,
	type OperationResult,
	type RefusalRecord,
	readRefusalRecord,
} from "@apnex/operation-call";
import { observePromises, readPlainJson } from "@apnex/shape-check";
import { inputShape, isWrite, STORE_OPERATIONS, type StoreOperation, type WriteOperation } from "./store-operations.js";

/** What the application's writer naming is given: the caller's evidence, and AGP's delivery context. */
export interface CallerEvidence {
	/**
	 * The answer of the evidence function the host was given - in zorg, caller-identity's record - or null, read
	 * once as plain data into a deeply frozen JSON value; evidence that is not plain JSON ends the invocation
	 * failed (EM13; zorg's D54).
	 */
	readonly evidence: JsonValue;
	/** AGP's delivery context for the request, as AGP gave it (`peer-identity-evidence`). */
	readonly delivery: DeliveryContext;
}

/**
 * The application's writer naming (`host-named-writer`): the writer to record for a remote change, named from
 * the caller's evidence alone, or null when the evidence names none. It is never shown the input.
 */
export type WriterNaming = (caller: CallerEvidence) => string | null;

/** What the application's policy is asked before each operation (`ask-application-policy`). */
export interface PolicyQuestion {
	readonly operation: StoreOperation;
	/** The input as received, a deeply frozen JSON snapshot. */
	readonly input: JsonValue;
	/** The caller's evidence, as the evidence function answered it, or null, the same deeply frozen JSON snapshot the writer naming was given (`peer-identity-evidence`). */
	readonly evidence: JsonValue;
	/** AGP's delivery context for the request, as AGP gave it. */
	readonly delivery: DeliveryContext;
	/** The writer the application named, for a write; null for a read, or when no writer was named. */
	readonly writer: string | null;
	/** The entity an update or delete names, a deeply frozen JSON snapshot, when it is not a recognised repeat and names one; otherwise null. */
	readonly target: EntityEnvelope | null;
	/** True when the write is a recognised repeat (EM7), which returns the first answer if allowed. */
	readonly repeat: boolean;
}

/** The policy's ruling: allowed, or refused with a refusal record (EM9) that is returned unchanged. */
export type PolicyRuling = { readonly allowed: true } | { readonly allowed: false; readonly refusal: RefusalRecord };

/** The application's policy: asked, synchronously, before each operation; entity-api never decides. */
export type ApplicationPolicy = (question: PolicyQuestion) => PolicyRuling;

/** What a store is served with. */
export interface StoreServerOptions {
	/** The host's AGP node, on which every operation is exposed as its own endpoint. */
	readonly node: AgpNode;
	/** The name the store is reached by, matching EM1's pattern; each operation is `<service>/<operation>`. */
	readonly service: string;
	/** The open store served; nothing else writes it remotely. */
	readonly store: EntityStore;
	/** Names the writer of each remote change from the caller's evidence. */
	readonly nameWriter: WriterNaming;
	/** Rules before each operation whether the caller may act. */
	readonly policy: ApplicationPolicy;
	/** operation-call's evidence port, asked for each request as it arrives; its answer is the caller's evidence. */
	readonly evidence?: EvidenceFunction;
}

/** A store being served. */
export interface StoreServer {
	readonly service: string;
	/** The description `<service>/describe` answers (EM10). */
	description(): Description;
	/** Closes every endpoint; nothing more is served. */
	close(): Promise<void>;
}

/** Whether the store is served: operation-call's host refuses a name EM1's pattern does not allow. */
export type StoreServing = { readonly served: true; readonly server: StoreServer } | { readonly served: false; readonly refusal: HostRefusal };

/**
 * Reads what application code handed back, or what entity-api hands it, as plain data through shape-check's
 * `readPlainJson` (zorg's D54, D55): a fresh deeply frozen plain JSON value, read through own enumerable data
 * descriptors only, running none of its code. Anything else - a getter, an inherited field, a non-enumerable
 * property, a symbol, a class instance, a promise, a cycle - is thrown as the application's defect, every
 * native promise met having been given a handler that does nothing, so operation-call ends the invocation
 * `failed` with `operation-failed` (EM13).
 */
function plain(value: unknown, what: string): JsonValue {
	const reading = readPlainJson(value);
	if (!reading.ok) throw new TypeError(`${what} must be plain JSON data, read without running any of its code (zorg's D54)`);
	return reading.value;
}

/**
 * Asks the policy and reads its ruling once, as plain data (EM13; zorg's D54, D55): through shape-check's
 * `readPlainJson`, so no getter, `then` probe or other code of the ruling runs, and every native promise met
 * anywhere in it is given a handler that does nothing; and its refusal through operation-call's
 * `readRefusalRecord`. The ruling is exactly `{allowed: true}`, or exactly `{allowed: false, refusal}` with a
 * refusal in EM9's form, passed on as read; anything else, and anything the policy throws, is thrown, so
 * operation-call ends the invocation `failed` with `operation-failed` and nothing is written. Nothing is awaited.
 */
function rule(policy: ApplicationPolicy, question: PolicyQuestion): PolicyRuling {
	let given: unknown;
	try {
		given = policy(question);
	} catch (err) {
		// What the policy throws is its defect: every native promise in it is given a handler that does nothing,
		// without reading any of its code, before it is thrown on (principle 7; zorg's D54).
		observePromises(err);
		throw err;
	}
	const ruling = plain(given, "the application's policy's ruling");
	if (ruling !== null && typeof ruling === "object" && !Array.isArray(ruling)) {
		const fields = Object.keys(ruling);
		const { allowed, refusal } = ruling as { readonly allowed?: JsonValue; readonly refusal?: JsonValue };
		if (allowed === true && fields.length === 1) return { allowed: true };
		if (allowed === false && fields.length === 2 && Object.hasOwn(ruling, "refusal")) {
			const record = readRefusalRecord(refusal);
			if (record.ok) return { allowed: false, refusal: record.refusal };
			throw new TypeError("the application's policy refused with no refusal record in EM9's form");
		}
	}
	throw new TypeError("the application's policy ruled with neither { allowed: true } nor { allowed: false, refusal }");
}

/**
 * Names the writer, checking what the application gave: a string, or null for none (EM13). Anything else is
 * thrown, without reading any of it - no `then` is probed and no getter runs - after shape-check's
 * `observePromises` has given every native promise in it a handler that does nothing, so its rejection never
 * goes unhandled (zorg's D54, D55).
 */
function nameFrom(nameWriter: WriterNaming, caller: CallerEvidence): string | null {
	let writer: unknown;
	try {
		writer = nameWriter(caller);
	} catch (err) {
		// What the writer naming throws is observed as the policy's throw is, then thrown on (zorg's D54).
		observePromises(err);
		throw err;
	}
	if (writer === null || typeof writer === "string") return writer;
	observePromises(writer);
	throw new TypeError("the application's writer naming must give a string, or null when the evidence names no writer");
}

/**
 * The application's evidence port as entity-api hands it to operation-call's host, which awaits its answer
 * (EM13; zorg's D54, D55). The application's answer is read here, before anything awaits it: a native promise
 * - the declared asynchronous completion - is followed through `Promise.prototype.then` itself, its value then
 * read as plain data; any other answer is read as plain data at once, through shape-check's `readPlainJson`,
 * so no `then` is probed, no getter runs and no non-native thenable is assimilated. What the host then awaits
 * is a deeply frozen plain JSON value, which has no function `then`. Whatever the port throws, or its promise
 * rejects with, has every native promise in it given a handler that does nothing before it is thrown on, so
 * operation-call ends the invocation `failed` with `operation-failed` and no rejection goes unhandled.
 */
function plainEvidence(evidence: EvidenceFunction): EvidenceFunction {
	return (delivery: DeliveryContext): unknown => {
		let raw: unknown;
		try {
			raw = evidence(delivery);
		} catch (err) {
			observePromises(err);
			throw err;
		}
		let native = false;
		try {
			native = raw instanceof Promise;
		} catch {
			native = false;
		}
		if (native) {
			return Reflect.apply(Promise.prototype.then, raw, [
				(resolved: unknown) => plain(resolved, "the caller's evidence"),
				(err: unknown) => {
					observePromises(err);
					throw err;
				},
			]);
		}
		return plain(raw, "the caller's evidence");
	};
}

/** A store's outcome as an operation's result: its answer or its refusal, unchanged. */
function result(outcome: StoreOutcome<unknown>): OperationResult {
	return outcome as OperationResult;
}

/** Serves a store's operations under a name, each at its own endpoint, or gives operation-call's refusal of the name. */
export async function serveStore(options: StoreServerOptions): Promise<StoreServing> {
	if (options === null || typeof options !== "object") throw new TypeError("serveStore needs { node, service, store, nameWriter, policy }");
	const { node, service, store, nameWriter, policy, evidence } = options;
	for (const method of ["create", "update", "delete", "read", "find", "historyBound", "checkRepeat"] as const) {
		if (!store || typeof store[method] !== "function") throw new TypeError(`serveStore needs an open entity store, offering ${method}`);
	}
	if (typeof nameWriter !== "function") throw new TypeError("serveStore needs the application's writer naming, a function of the caller's evidence");
	if (typeof policy !== "function") throw new TypeError("serveStore needs the application's policy, a function ruling on each operation");

	const opening = await createOperationHost(node, evidence === undefined ? { service } : { service, evidence: typeof evidence === "function" ? plainEvidence(evidence) : evidence });
	if (!opening.opened) return { served: false, refusal: opening.refusal };
	const host = opening.host;

	/** Resolves the target of an update or delete to the entity it names, if any (EM13, step 3). */
	const resolve = (input: JsonValue): EntityEnvelope | null => {
		const read = store.read({ target: (input as { target: { id?: string; kind?: string; name?: string } }).target });
		return read.outcome === "answered" && read.answer.entity !== null ? plain(read.answer.entity, "the target's envelope") as unknown as EntityEnvelope : null;
	};

	/** A write, in EM13's synchronous order; nothing in it awaits. */
	const write = (operation: WriteOperation, input: JsonValue, context: OperationContext, evidence: JsonValue): OperationResult => {
		const writer = nameFrom(nameWriter, Object.freeze({ evidence, delivery: context.delivery }));
		const identity: WriteContext | undefined = writer === null ? undefined : { writer, writeId: context.invocation };
		const check: RepeatCheck = identity === undefined ? { repeat: "none" } : store.checkRepeat(operation, input as never, identity);
		const repeat = check.repeat === "recognised";
		const target = repeat || operation === "create" ? null : resolve(input);
		const ruling = rule(policy, Object.freeze({ operation, input: plain(input, "an operation's input"), evidence, delivery: context.delivery, writer, target, repeat }));
		if (!ruling.allowed) return { outcome: "refused", refusal: ruling.refusal };
		if (check.repeat === "recognised") return { outcome: "answered", answer: check.answer as unknown as JsonValue };
		if (identity === undefined) throw new Error("the application's policy allowed a write for which its writer naming named no writer, so there is no writer to record");
		switch (operation) {
			case "create": return result(store.create(input as never, identity));
			case "update": return result(store.update(input as never, identity));
			case "delete": return result(store.delete(input as never, identity));
		}
	};

	/** A read, a find or history-bound: the policy rules, then the store answers. */
	const answer = (operation: Exclude<StoreOperation, WriteOperation>, input: JsonValue, context: OperationContext, evidence: JsonValue): OperationResult => {
		const ruling = rule(policy, Object.freeze({ operation, input: plain(input, "an operation's input"), evidence, delivery: context.delivery, writer: null, target: null, repeat: false }));
		if (!ruling.allowed) return { outcome: "refused", refusal: ruling.refusal };
		switch (operation) {
			case "read": return result(store.read(input as never));
			case "find": return result(store.find(input as never));
			case "history-bound": return result(store.historyBound());
		}
	};

	try {
		for (const operation of STORE_OPERATIONS) {
			const handler = (input: JsonValue, context: OperationContext): OperationResult => {
				// The request's evidence, read once as plain data through shape-check's readPlainJson into a deeply
				// frozen JSON value that the writer naming and the policy share; evidence that is not plain JSON is
				// the application's defect, thrown, so the invocation ends `failed` with `operation-failed` before
				// either is asked (EM13; zorg's D54, D55).
				const evidence = plain(context.evidence, "the request's evidence");
				return isWrite(operation) ? write(operation, input, context, evidence) : answer(operation, input, context, evidence);
			};
			const declared = await host.declare({ name: operation, input: inputShape(operation) as JsonValue, answers: "whole" }, handler);
			if (!declared.declared) throw new Error(`operation-call refused to declare ${operation}: ${declared.refusal.code}; this is a defect of entity-api`);
		}
	} catch (error) {
		await host.close();
		throw error;
	}

	return {
		served: true,
		server: Object.freeze({
			service: host.service,
			description: () => host.description(),
			close: () => host.close(),
		}),
	};
}
