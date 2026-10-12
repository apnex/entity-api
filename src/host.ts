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
 * decides nothing itself: it never refuses for its own reasons, and owns no refusal code. Nothing here is
 * particular to one runtime (zorg's D31).
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
} from "@apnex/operation-call";
import { frozenSnapshot, snapshotJson, type Meeting, type MemberRead } from "./json.js";
import { inputShape, isWrite, STORE_OPERATIONS, type StoreOperation, type WriteOperation } from "./store-operations.js";

/** What the application's writer naming is given: the caller's evidence, and AGP's delivery context. */
export interface CallerEvidence {
	/**
	 * The answer of the evidence function the host was given - in zorg, caller-identity's record - or null, as a
	 * deeply frozen JSON snapshot read once; evidence that is not a JSON value ends the invocation failed (EM13).
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

/** True when a value has a `then` method; reading it is guarded, since a getter may throw. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
	try {
		return value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
	} catch {
		return false;
	}
}

/** Consumes a thenable's outcome, so a rejection the application returned never goes unhandled. */
function consume(value: PromiseLike<unknown>): void {
	try {
		Promise.resolve(value).catch(() => undefined);
	} catch {
		// A thenable whose then throws has no outcome to consume.
	}
}

/** Reads a value's `then` once, guarded, since a getter may throw: its value, or what reading it threw. */
function readThen(value: object): MemberRead {
	try {
		return { threw: false, value: (value as { then?: unknown }).then };
	} catch (error) {
		return { threw: true, error };
	}
}

/** A handler that does nothing. */
const ignore = (): void => undefined;

/**
 * Observes a promise through the `then` already read from it, called with two handlers that do nothing, so a
 * rejection is consumed and `then` is not read again, as Promise.resolve would read it.
 */
function observe(value: object, then: (...handlers: unknown[]) => unknown): void {
	try {
		Reflect.apply(then, value, [ignore, ignore]);
	} catch {
		// A then that throws has no outcome to consume.
	}
}

/**
 * Asks the policy and reads its ruling once, each field once (EM13). Anything but a synchronous ruling of the
 * declared form is the application's fault, thrown, so operation-call ends the invocation `failed` with
 * `operation-failed` and nothing is written. A promise met anywhere in reading the ruling - as the ruling, as
 * its `allowed`, as its refusal or within the refusal - has its outcome consumed as it is read, before anything
 * further is read, so a getter read later that throws cannot strand it; every one is consumed before the
 * ruling is refused, so none escapes to the host's runtime as an unhandled rejection; nothing is awaited. Each
 * value's `then` is read once: one that is a function makes the value a promise, observed through it; any
 * other is read on, and a refusal's or a refusal member's `then` member is taken from that one read (EM10).
 * The refusal is read once, whole, into a JSON copy equal to it, and that copy is what is passed on.
 */
function rule(policy: ApplicationPolicy, question: PolicyQuestion): PolicyRuling {
	const ruling: unknown = policy(question);
	let promised = false;
	/** Reads an item's `then` once; a promise met in the ruling is observed, and the ruling then refused; its refusal is read all the same. */
	const meet = (item: object): Meeting => {
		const then = readThen(item);
		if (then.threw || typeof then.value !== "function") return { taken: false, then };
		observe(item, then.value as (...handlers: unknown[]) => unknown);
		promised = true;
		return { taken: true };
	};
	const isObject = (value: unknown): value is object => value !== null && (typeof value === "object" || typeof value === "function");
	if (isObject(ruling) && meet(ruling).taken) {
		throw new TypeError("the application's policy must rule synchronously, so no change lands between its ruling and the write (EM13)");
	}
	if (ruling === null || typeof ruling !== "object") throw new TypeError("the application's policy ruled with neither { allowed: true } nor { allowed: false, refusal }");
	// Each field is met as it is read, before the next is read, so a getter that throws later cannot leave a
	// promise already read unconsumed.
	const allowed: unknown = (ruling as { allowed?: unknown }).allowed;
	if (isObject(allowed)) meet(allowed);
	const refusal: unknown = (ruling as { refusal?: unknown }).refusal;
	const copy = refusal === undefined ? undefined : snapshotJson(refusal, meet);
	if (promised) throw new TypeError("the application's policy must rule synchronously, with no promise in its ruling (EM13)");
	if (allowed === true) return { allowed: true };
	if (allowed === false && copy !== undefined) return { allowed: false, refusal: copy as RefusalRecord };
	throw new TypeError("the application's policy ruled with neither { allowed: true } nor { allowed: false, refusal }");
}

/** Names the writer, checking what the application gave: a string, or null for none. */
function nameFrom(nameWriter: WriterNaming, caller: CallerEvidence): string | null {
	const writer: unknown = nameWriter(caller);
	if (writer === null || typeof writer === "string") return writer;
	if (isThenable(writer)) consume(writer);
	throw new TypeError("the application's writer naming must give a string, or null when the evidence names no writer");
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

	const opening = await createOperationHost(node, evidence === undefined ? { service } : { service, evidence });
	if (!opening.opened) return { served: false, refusal: opening.refusal };
	const host = opening.host;

	/** Resolves the target of an update or delete to the entity it names, if any (EM13, step 3). */
	const resolve = (input: JsonValue): EntityEnvelope | null => {
		const read = store.read({ target: (input as { target: { id?: string; kind?: string; name?: string } }).target });
		return read.outcome === "answered" && read.answer.entity !== null ? frozenSnapshot(read.answer.entity, "the target's envelope") : null;
	};

	/** A write, in EM13's synchronous order; nothing in it awaits. */
	const write = (operation: WriteOperation, input: JsonValue, context: OperationContext, evidence: JsonValue): OperationResult => {
		const writer = nameFrom(nameWriter, Object.freeze({ evidence, delivery: context.delivery }));
		const identity: WriteContext | undefined = writer === null ? undefined : { writer, writeId: context.invocation };
		const check: RepeatCheck = identity === undefined ? { repeat: "none" } : store.checkRepeat(operation, input as never, identity);
		const repeat = check.repeat === "recognised";
		const target = repeat || operation === "create" ? null : resolve(input);
		const ruling = rule(policy, Object.freeze({ operation, input: frozenSnapshot(input, "an operation's input"), evidence, delivery: context.delivery, writer, target, repeat }));
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
		const ruling = rule(policy, Object.freeze({ operation, input: frozenSnapshot(input, "an operation's input"), evidence, delivery: context.delivery, writer: null, target: null, repeat: false }));
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
				// The request's evidence, read once into a deeply frozen JSON snapshot that the writer naming and the
				// policy share; evidence that is not a JSON value is the application's defect, thrown, so the
				// invocation ends `failed` with `operation-failed` before either is asked (EM13).
				const evidence = frozenSnapshot(context.evidence, "the request's evidence") as JsonValue;
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
