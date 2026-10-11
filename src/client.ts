/**
 * The client half (zorg's target, EM7, EM10, EM12): the store's operations offered to application logic as
 * if the store were local, each one invocation of the operation-call caller it is given - operation-call's
 * own caller, or operation-proxy's client half, which offers the same interface - pinned to the host the
 * application names.
 *
 * Every operation ends as the call layer ends it - answered with the store's answer, refused with the
 * refusal record unchanged, not delivered, or unknown - and the ending is returned unchanged. A write's
 * identity is its invocation identity: the client never writes a writer or a write identity into an input,
 * and an application repeats a write by repeating its invocation (EM7, `repeat-recognition`).
 *
 * `find` is the whole find of EM10: every match, `{position, entries}`, read page by page as of the first
 * page's position within one deadline; `findPage` is one page, exactly as the store answers it. Nothing here
 * is particular to one runtime (zorg's D31): time and randomness come from the ports it is given, by default
 * operation-call's.
 */
import {
	systemCallClock,
	systemIdentitySource,
	MAX_BOUND_MS,
	type AnsweredEnding,
	type CallClock,
	type CallEnding,
	type IdentitySource,
	type JsonInput,
	type JsonValue,
	type NotDeliveredEnding,
	type OperationCaller,
	type RefusedEnding,
	type UnknownEnding,
} from "@apnex/operation-call";
import { isInvocationId, NAME_PATTERN } from "@apnex/operation-call/message-format";
import { copyJsonOnce } from "./json.js";
import type { StoreOperation } from "./store-operations.js";

/** What a client is built from. */
export interface StoreClientOptions {
	/** The caller every operation is invoked through: operation-call's caller, or anything offering its interface. */
	readonly caller: OperationCaller;
	/** The AGP node of the host the application means; every call is pinned to it (`advertiser-instance-select`). */
	readonly host: string;
	/** The name the store is reached by, matching EM1's pattern. */
	readonly service: string;
	/** The bound of any call that names none, in whole milliseconds from 1 to 2147483647; none when absent. */
	readonly bound?: number;
	/** The clock a whole find's deadline is kept on; give the caller's own. operation-call's default when absent. */
	readonly clock?: CallClock;
	/** Where a whole find takes an invocation identity it must report before any page was sent; operation-call's default when absent. */
	readonly identities?: IdentitySource;
}

/** What each call may name. */
export interface CallOptions {
	/** The call's bound, in whole milliseconds from 1 to 2147483647, starting when the operation is called. */
	readonly bound?: number;
	/** The invocation identity to use, as EM11 writes it; a new one when absent. */
	readonly invocation?: string;
	/** Passed to the call layer for each send, as EM12 says. */
	readonly signal?: AbortSignal;
}

/** What a write may name besides: that it repeats an invocation that may have taken effect. */
export interface WriteOptions extends CallOptions {
	readonly repeat?: boolean;
}

/** An ending whose attempt is null when no attempt was made: a whole find whose bound passed before its first page. */
type FindEndingOf<E> = Omit<E, "attempt"> & { readonly attempt: string | null };

/** How a whole find ends (EM10): its identity is always its first page's. */
export type FindEnding = FindEndingOf<AnsweredEnding> | FindEndingOf<RefusedEnding> | FindEndingOf<NotDeliveredEnding> | FindEndingOf<UnknownEnding>;

/** The store's operations, as if the store were local. */
export interface StoreClient {
	readonly host: string;
	readonly service: string;
	create(input: JsonInput, options?: WriteOptions): Promise<CallEnding>;
	update(input: JsonInput, options?: WriteOptions): Promise<CallEnding>;
	delete(input: JsonInput, options?: WriteOptions): Promise<CallEnding>;
	read(input: JsonInput, options?: CallOptions): Promise<CallEnding>;
	/** One page of a find, answered `{position, entries, next}` exactly as the store answers it. */
	findPage(input: JsonInput, options?: CallOptions): Promise<CallEnding>;
	/** The whole find: every match, answered `{position, entries}`, within one deadline (EM10). */
	find(input: JsonInput, options?: CallOptions): Promise<FindEnding>;
	historyBound(options?: CallOptions): Promise<CallEnding>;
}

/** Throws unless a bound is a whole number of milliseconds from 1 to 2147483647 (EM12). */
function checkBound(bound: unknown): number {
	if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 1 || bound > MAX_BOUND_MS) {
		throw new RangeError("a call's bound is a whole number of milliseconds from 1 to 2147483647");
	}
	return bound;
}

/** Reads a call's options, which are an object or absent. */
function optionsOf<O extends object>(options: O | undefined): Partial<O> {
	if (options === undefined) return {};
	if (options === null || typeof options !== "object") throw new TypeError("a call's options are an object: { bound, invocation, signal }");
	return options;
}

/** Builds a client of the store served under `service` on the host `host`. */
export function createStoreClient(options: StoreClientOptions): StoreClient {
	if (options === null || typeof options !== "object") throw new TypeError("createStoreClient needs { caller, host, service }");
	const { caller, host, service } = options;
	const clock = options.clock ?? systemCallClock;
	const identities = options.identities ?? systemIdentitySource;
	if (!caller || typeof caller.invoke !== "function") throw new TypeError("createStoreClient needs a caller offering invoke, as operation-call's caller does");
	if (typeof host !== "string" || host.length === 0) throw new TypeError("a client names the host it means as an AGP node identifier");
	if (typeof service !== "string" || !NAME_PATTERN.test(service)) throw new TypeError("a client's service must match ^[a-z0-9][a-z0-9-]{0,62}$");
	if (options.bound !== undefined) checkBound(options.bound);
	if (!clock || typeof clock.now !== "function") throw new TypeError("a client's clock offers now, as operation-call's call clock does");
	if (!identities || typeof identities.wallTimeMs !== "function" || typeof identities.randomHex !== "function") throw new TypeError("a client's identities offer wallTimeMs and randomHex");

	/** One invocation of an operation; the caller checks the arguments and throws for a programming error. */
	const invoke = (operation: StoreOperation, input: JsonInput, given: Partial<WriteOptions>, repeatable: boolean): Promise<CallEnding> => {
		const bound = given.bound ?? options.bound;
		return caller.invoke({
			host,
			service,
			operation,
			input,
			bound: bound as number,
			...(given.invocation === undefined ? {} : { invocation: given.invocation }),
			...(repeatable && given.repeat !== undefined ? { repeat: given.repeat } : {}),
			...(given.signal === undefined ? {} : { signal: given.signal }),
		});
	};

	/** Reads the deadline's clock; a reading that is not a finite number is a fault of the port. */
	const now = (): number => {
		const reading = clock.now();
		if (typeof reading !== "number" || !Number.isFinite(reading)) throw new TypeError(`the client's clock read ${String(reading)}, not a finite number of milliseconds`);
		return reading;
	};

	/** A new invocation identity as EM11 writes it, for a find that must report one before any page was sent. */
	const newInvocation = (): string => {
		const ms = Math.floor(identities.wallTimeMs());
		const hex = identities.randomHex(16);
		const identity = `${String(ms).padStart(13, "0")}-${hex}`;
		if (!isInvocationId(identity)) throw new TypeError("the client's identities gave no invocation identity as EM11 writes it");
		return identity;
	};

	/**
	 * The whole find of EM10. One deadline from the moment it is called; each page invoked with the time left,
	 * rounded down to a whole millisecond, as its bound; no page sent with less than 1 millisecond left; the
	 * first page under the identity given, or a new one, each later page under a new identity, as of the first
	 * page's position and after the last page's `next`.
	 */
	const find = async (input: JsonInput, call?: CallOptions): Promise<FindEnding> => {
		const start = now();
		const given = optionsOf(call);
		const bound = checkBound(given.bound ?? options.bound);
		if (given.invocation !== undefined && !isInvocationId(given.invocation)) throw new TypeError("a call's invocation must be an invocation identity as EM11 writes it");
		const query = copyJsonOnce(input);
		if (query === undefined) throw new TypeError("a find's input must be a JSON value");
		const deadline = start + bound;
		let first: { readonly invocation: string; readonly attempt: string } | undefined;
		let position: JsonValue | undefined;
		const entries: JsonValue[] = [];
		let page: JsonInput = query as JsonInput;
		for (;;) {
			const left = deadline - now();
			if (left < 1) {
				return Object.freeze({
					ending: "unknown", invocation: first?.invocation ?? given.invocation ?? newInvocation(), attempt: first?.attempt ?? null,
					operation: "find", reason: "bound-passed", agpCode: null, deliveryReport: null,
				});
			}
			const ending = await invoke("find", page, { bound: Math.floor(left), ...(first === undefined && given.invocation !== undefined ? { invocation: given.invocation } : {}), ...(given.signal === undefined ? {} : { signal: given.signal }) }, false);
			first ??= { invocation: ending.invocation, attempt: ending.attempt };
			if (ending.ending !== "answered") return Object.freeze({ ...ending, invocation: first.invocation, attempt: first.attempt });
			const answer = ending.answer as { position?: JsonValue; entries?: unknown; next?: unknown } | null;
			if (answer === null || typeof answer !== "object" || !Array.isArray(answer.entries)) return Object.freeze({ ...ending, invocation: first.invocation, attempt: first.attempt });
			position ??= answer.position as JsonValue;
			entries.push(...(answer.entries as JsonValue[]));
			if (typeof answer.next !== "string") {
				return Object.freeze({
					ending: "answered", invocation: first.invocation, attempt: first.attempt, operation: "find",
					answer: Object.freeze({ position: position as JsonValue, entries: Object.freeze(entries) as unknown as JsonValue[] }),
				});
			}
			page = { ...(query as { [name: string]: JsonValue }), asOf: position as JsonValue, after: answer.next };
		}
	};

	return Object.freeze({
		host,
		service,
		create: async (input: JsonInput, o?: WriteOptions) => invoke("create", input, optionsOf(o), true),
		update: async (input: JsonInput, o?: WriteOptions) => invoke("update", input, optionsOf(o), true),
		delete: async (input: JsonInput, o?: WriteOptions) => invoke("delete", input, optionsOf(o), true),
		read: async (input: JsonInput, o?: CallOptions) => invoke("read", input, optionsOf(o), false),
		findPage: async (input: JsonInput, o?: CallOptions) => invoke("find", input, optionsOf(o), false),
		find,
		historyBound: async (o?: CallOptions) => invoke("history-bound", {}, optionsOf(o), false),
	});
}
