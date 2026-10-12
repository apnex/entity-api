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
	type CallClock,
	type CallEnding,
	type IdentitySource,
	type JsonInput,
	type JsonValue,
	type OperationCaller,
} from "@apnex/operation-call";
import { isInvocationId, NAME_PATTERN } from "@apnex/operation-call/message-format";
import { snapshotJson } from "./json.js";
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

/**
 * One of the caller's endings as a whole find gives it: every field the caller gave, unchanged, but its
 * invocation and attempt the first page's, and its attempt null when the bound passed before any page was sent.
 * It distributes over the caller's endings, so each keeps its own fields - a hop's `proxyCode` and reasons
 * included (EM12) - and none is narrowed.
 */
type FindEndingOf<E> = E extends unknown ? Omit<E, "attempt"> & { readonly attempt: string | null } : never;

/**
 * How a whole find ends (EM10): as its last page ended, through whatever caller the client was given - so every
 * ending the caller interface admits, a caller across a hop's included (EM12) - under its first page's identity.
 */
export type FindEnding = FindEndingOf<CallEnding>;

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

/**
 * Reads a call's options, which are an object or absent, once, into a snapshot: each field the call takes -
 * the bound, the invocation, the signal, and for a write the repeat flag - is read exactly once, now, and
 * never again, so no getter of the caller's runs once the call is under way (EM10).
 */
function optionsOf(options: WriteOptions | undefined, repeatable: boolean): Partial<WriteOptions> {
	if (options === undefined) return {};
	if (options === null || typeof options !== "object") throw new TypeError("a call's options are an object: { bound, invocation, signal }");
	const bound = options.bound;
	const invocation = options.invocation;
	const signal = options.signal;
	const repeat = repeatable ? options.repeat : undefined;
	return {
		...(bound === undefined ? {} : { bound }),
		...(invocation === undefined ? {} : { invocation }),
		...(signal === undefined ? {} : { signal }),
		...(repeat === undefined ? {} : { repeat }),
	};
}

/** A page's answer as EM10 gives it, its fields read once, or undefined when the answer is not a page. */
interface PageForm { readonly position: number; readonly entries: readonly JsonValue[]; readonly next: string | null }

/**
 * Recognises a page (EM10): an object holding a `position` that is a whole number, an `entries` array and a
 * `next` that is a name or null. Each field, and each entry, is read once, so nothing of the answer is read
 * after the find has read its clock.
 */
function pageOf(answer: unknown): PageForm | undefined {
	if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return undefined;
	const { position, entries, next } = answer as { position?: unknown; entries?: unknown; next?: unknown };
	if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) return undefined;
	if (!Array.isArray(entries)) return undefined;
	if (next !== null && (typeof next !== "string" || !NAME_PATTERN.test(next))) return undefined;
	const held: JsonValue[] = [];
	const length = entries.length;
	for (let i = 0; i < length; i++) held.push(entries[i] as JsonValue);
	return { position, entries: held, next };
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

	// The caller's invoke and the clock's now are read once, here, so no getter of theirs runs between a
	// page's clock reading and its invocation (EM10).
	const callerInvoke = caller.invoke;
	const clockNow = clock.now;

	/** One invocation of an operation; the caller checks the arguments and throws for a programming error. */
	const invoke = (operation: StoreOperation, input: JsonInput, given: Partial<WriteOptions>, repeatable: boolean): Promise<CallEnding> => {
		const bound = given.bound ?? options.bound;
		return callerInvoke.call(caller, {
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
		const reading: unknown = clockNow.call(clock);
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
	 * The whole find of EM10. Its clock is read as it is called, before anything else, as every caller reads
	 * its own (EM12); then its input and options are read once, into a snapshot, and its one deadline is that
	 * first reading plus the bound, so the time the snapshot takes is spent from the bound. Each page is invoked
	 * with the time left, read immediately before that page is invoked and rounded down to a whole millisecond,
	 * as its bound, so no getter of the caller's runs between that reading and the invocation; no page is sent
	 * with less than 1 millisecond left - the first included, when preparing the find used the bound up - and no
	 * page is taken once the deadline has passed. The first page goes under the identity given, or a new one,
	 * each later page under a new identity, as of the first page's position and after the last page's `next`.
	 * A page whose answer is not a page ends the find answered with that answer unchanged. Every ending is the
	 * caller's, unchanged but for the first page's invocation and attempt.
	 */
	const find = async (input: JsonInput, call?: CallOptions): Promise<FindEnding> => {
		const start = now();
		const given = optionsOf(call, false);
		const bound = checkBound(given.bound ?? options.bound);
		if (given.invocation !== undefined && !isInvocationId(given.invocation)) throw new TypeError("a call's invocation must be an invocation identity as EM11 writes it");
		let query: unknown;
		try {
			query = snapshotJson(input);
		} catch (error) {
			throw new TypeError("a find's input could not be read as a JSON value", { cause: error });
		}
		if (query === undefined) throw new TypeError("a find's input must be a JSON value");
		const deadline = start + bound;
		let first: { readonly invocation: string; readonly attempt: string | null } | undefined;
		let position: number | undefined;
		const entries: JsonValue[] = [];
		let page = query as JsonInput;
		const boundPassed = (): FindEnding => Object.freeze({
			ending: "unknown", invocation: first?.invocation ?? given.invocation ?? newInvocation(), attempt: first?.attempt ?? null,
			operation: "find", reason: "bound-passed", agpCode: null, deliveryReport: null,
		});
		for (;;) {
			const left = deadline - now();
			if (left < 1) return boundPassed();
			const request = {
				host, service, operation: "find", input: page, bound: Math.floor(left),
				...(first === undefined && given.invocation !== undefined ? { invocation: given.invocation } : {}),
				...(given.signal === undefined ? {} : { signal: given.signal }),
			};
			// The page's ending, its fields read once.
			const ending = { ...(await callerInvoke.call(caller, request)) } as CallEnding;
			const address = first ??= { invocation: ending.invocation, attempt: ending.attempt };
			if (ending.ending !== "answered") return Object.freeze({ ...ending, invocation: address.invocation, attempt: address.attempt });
			const form = pageOf(ending.answer);
			// An answer taken once the deadline has passed loses to it, as EM12 has a call's bound win.
			if (now() >= deadline) return boundPassed();
			if (form === undefined) return Object.freeze({ ...ending, invocation: address.invocation, attempt: address.attempt });
			position ??= form.position;
			for (const entry of form.entries) entries.push(entry);
			if (form.next === null) {
				return Object.freeze({
					ending: "answered", invocation: address.invocation, attempt: address.attempt, operation: "find",
					answer: Object.freeze({ position, entries: Object.freeze(entries) as unknown as JsonValue[] }),
				});
			}
			page = { ...(query as { [name: string]: JsonValue }), asOf: position, after: form.next };
		}
	};

	return Object.freeze({
		host,
		service,
		create: async (input: JsonInput, o?: WriteOptions) => invoke("create", input, optionsOf(o, true), true),
		update: async (input: JsonInput, o?: WriteOptions) => invoke("update", input, optionsOf(o, true), true),
		delete: async (input: JsonInput, o?: WriteOptions) => invoke("delete", input, optionsOf(o, true), true),
		read: async (input: JsonInput, o?: CallOptions) => invoke("read", input, optionsOf(o, false), false),
		findPage: async (input: JsonInput, o?: CallOptions) => invoke("find", input, optionsOf(o, false), false),
		find,
		historyBound: async (o?: CallOptions) => invoke("history-bound", {}, optionsOf(o, false), false),
	});
}
