/**
 * The client half (zorg's target, EM7, EM10, EM12): the store's operations offered to application logic as
 * if the store were local, each single call at most one invocation of the operation-call caller it is given -
 * operation-call's own caller, or operation-proxy's client half, which offers the same interface - pinned to
 * the host the application names.
 *
 * Every call, the whole find and each single call alike, reads its clock as it is called, before anything
 * else, as every caller reads its own (EM12), and then reads its input and options once, into a snapshot, so
 * a caller's programming error - a bound out of range or not whole, an input that is not a JSON value, an
 * invocation identity not as EM11 writes it, a repeat flag that is not a boolean - is thrown whatever the
 * time, and nothing is sent. Its deadline is that reading plus the bound, so the time the snapshot takes is
 * spent from the bound. A single call then gives the call layer the snapshot, with the time left until its
 * deadline, rounded down to a whole millisecond, as the call's bound, and ends as the call layer ends it -
 * answered with the store's answer, refused with the refusal record unchanged, not delivered, or unknown -
 * the ending returned unchanged. When less than 1 millisecond is left it sends nothing, and ends as the call
 * layer's caller ends a call whose bound passed while it prepared: unknown with `bound-passed`, under the
 * invocation identity given or a new one, with a new attempt identity of that invocation as EM11 writes it,
 * no AGP code and no delivery report, frozen - so a single call's ending is always one the caller interface
 * writes. A write's identity is its invocation identity: the client never writes a writer or a write
 * identity into an input, and an application repeats a write by repeating its invocation (EM7,
 * `repeat-recognition`).
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
import { isAttemptId, isInvocationId, NAME_PATTERN } from "@apnex/operation-call/message-format";
import { snapshotJson } from "./json.js";
import type { StoreOperation } from "./store-operations.js";

/** What a client is built from. */
export interface StoreClientOptions {
	/**
	 * The caller every call the client sends is invoked through: operation-call's caller, or anything offering
	 * its interface. A call whose bound passed while the client read its input and options is never handed to it.
	 */
	readonly caller: OperationCaller;
	/** The AGP node of the host the application means; every call is pinned to it (`advertiser-instance-select`). */
	readonly host: string;
	/** The name the store is reached by, matching EM1's pattern. */
	readonly service: string;
	/** The bound of any call that names none, in whole milliseconds from 1 to 2147483647; none when absent. */
	readonly bound?: number;
	/**
	 * The clock every call's deadline is kept on - a whole find's and each single call's, read as the call is
	 * called and again before the call layer is invoked - so give the caller's own. operation-call's default
	 * when absent.
	 */
	readonly clock?: CallClock;
	/**
	 * Where the client takes the identities of an ending it gives itself, having sent nothing: when a whole
	 * find's bound passed before any page was sent, its invocation identity, if none was given; when a single
	 * call's bound passed before it could be sent, its invocation identity, if none was given, and a new
	 * attempt identity of that invocation. operation-call's default when absent.
	 */
	readonly identities?: IdentitySource;
}

/** What each call may name. */
export interface CallOptions {
	/**
	 * The call's bound, in whole milliseconds from 1 to 2147483647, starting when the operation is called: the
	 * time the client takes reading the call's input and options is spent from it. A single call gives the call
	 * layer the time left, rounded down to a whole millisecond, as its bound, and a whole find gives each page
	 * the time left when that page is invoked; with less than 1 millisecond left nothing is sent, and the call
	 * ends unknown with `bound-passed`. A bound out of range or not whole is thrown, whatever the time.
	 */
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

/**
 * A call as begun (EM10): its deadline on the client's clock, and the snapshot of its input and of the options
 * it takes, read once and checked.
 */
interface Begun {
	readonly deadline: number;
	readonly input: JsonValue;
	readonly invocation?: string;
	readonly signal?: AbortSignal;
	readonly repeat?: boolean;
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
	// call's or a page's clock reading and its invocation (EM10).
	const callerInvoke = caller.invoke;
	const clockNow = clock.now;

	/** Reads the deadline's clock; a reading that is not a finite number is a fault of the port. */
	const now = (): number => {
		const reading: unknown = clockNow.call(clock);
		if (typeof reading !== "number" || !Number.isFinite(reading)) throw new TypeError(`the client's clock read ${String(reading)}, not a finite number of milliseconds`);
		return reading;
	};

	/**
	 * Begins a call, the whole find and every single call alike (EM10, EM12): the clock is read first, before
	 * anything else, then the options and the input are each read once, into a snapshot, and checked, so a
	 * programming error is thrown whatever the time. The call's deadline is that first reading plus the bound,
	 * so the time the snapshot takes is spent from the bound. The repeat flag is read only for a write.
	 */
	const begin = (input: JsonInput, call: WriteOptions | undefined, repeatable: boolean): Begun => {
		const start = now();
		const given = optionsOf(call, repeatable);
		const bound = checkBound(given.bound ?? options.bound);
		if (given.invocation !== undefined && !isInvocationId(given.invocation)) throw new TypeError("a call's invocation must be an invocation identity as EM11 writes it");
		if (given.repeat !== undefined && typeof given.repeat !== "boolean") throw new TypeError("a call's repeat flag is true or false");
		const signal: unknown = given.signal;
		if (signal !== undefined && (signal === null || typeof (signal as { aborted?: unknown }).aborted !== "boolean")) throw new TypeError("a call's signal must be an AbortSignal");
		let snapshot: unknown;
		try {
			snapshot = snapshotJson(input);
		} catch (error) {
			throw new TypeError("a call's input could not be read as a JSON value", { cause: error });
		}
		if (snapshot === undefined) throw new TypeError("a call's input must be a JSON value");
		return {
			deadline: start + bound,
			input: snapshot as JsonValue,
			...(given.invocation === undefined ? {} : { invocation: given.invocation }),
			...(given.signal === undefined ? {} : { signal: given.signal }),
			...(given.repeat === undefined ? {} : { repeat: given.repeat }),
		};
	};

	/** The time left until a call's deadline, read now, so it is read immediately before the call layer is invoked. */
	const timeLeft = (deadline: number): number => deadline - now();

	/** The ending of a call whose bound passed with nothing sent: unknown with `bound-passed`, frozen (EM12). */
	const boundPassed = <A extends string | null>(operation: string, invocation: string, attempt: A) => Object.freeze({
		ending: "unknown", invocation, attempt, operation, reason: "bound-passed", agpCode: null, deliveryReport: null,
	} as const);

	/** A new invocation identity as EM11 writes it, for an ending the client gives itself with none given. */
	const newInvocation = (): string => {
		const ms = Math.floor(identities.wallTimeMs());
		const hex = identities.randomHex(16);
		const identity = `${String(ms).padStart(13, "0")}-${hex}`;
		if (!isInvocationId(identity)) throw new TypeError("the client's identities gave no invocation identity as EM11 writes it");
		return identity;
	};

	/** A new attempt identity of an invocation as EM11 writes it, for a single call that ends with nothing sent. */
	const newAttempt = (invocation: string): string => {
		const identity = `${invocation}.${identities.randomHex(8)}`;
		if (!isAttemptId(identity)) throw new TypeError("the client's identities gave no attempt identity as EM11 writes it");
		return identity;
	};

	/**
	 * A single call (EM10): begun as every call is, then given to the call layer as one invocation with the
	 * snapshot, and the time left, rounded down to a whole millisecond, as its bound; its ending is the call
	 * layer's, unchanged. When less than 1 millisecond is left nothing is sent, and the call ends as the call
	 * layer's caller ends a call whose bound passed while it prepared: under the invocation identity given or
	 * a new one, with a new attempt identity of that invocation.
	 */
	const single = async (operation: StoreOperation, input: JsonInput, call: WriteOptions | undefined, repeatable: boolean): Promise<CallEnding> => {
		const begun = begin(input, call, repeatable);
		const left = timeLeft(begun.deadline);
		if (left < 1) {
			const invocation = begun.invocation ?? newInvocation();
			return boundPassed(operation, invocation, newAttempt(invocation));
		}
		return callerInvoke.call(caller, {
			host,
			service,
			operation,
			input: begun.input,
			bound: Math.floor(left),
			...(begun.invocation === undefined ? {} : { invocation: begun.invocation }),
			...(begun.repeat === undefined ? {} : { repeat: begun.repeat }),
			...(begun.signal === undefined ? {} : { signal: begun.signal }),
		});
	};

	/**
	 * The whole find of EM10, begun as every call is: its clock is read as it is called, before anything else,
	 * as every caller reads its own (EM12); then its input and options are read once, into a snapshot, and its
	 * one deadline is that first reading plus the bound, so the time the snapshot takes is spent from the bound,
	 * as for a single call. Each page is invoked with the time left, read immediately before that page is
	 * invoked and rounded down to a whole millisecond, as its bound, so no getter of the caller's runs between
	 * that reading and the invocation; no page is sent with less than 1 millisecond left - the first included,
	 * when preparing the find used the bound up, the find then ending with attempt null, as no page was sent -
	 * and no page is taken once the deadline has passed. The first page goes under the identity given, or a new
	 * one, each later page under a new identity, as of the first page's position and after the last page's
	 * `next`. A page whose answer is not a page ends the find answered with that answer unchanged. Every ending
	 * is the caller's, unchanged but for the first page's invocation and attempt.
	 */
	const find = async (input: JsonInput, call?: CallOptions): Promise<FindEnding> => {
		const { deadline, input: query, invocation, signal } = begin(input, call, false);
		let first: { readonly invocation: string; readonly attempt: string | null } | undefined;
		let position: number | undefined;
		const entries: JsonValue[] = [];
		let page = query as JsonInput;
		const passed = (): FindEnding => boundPassed("find", first?.invocation ?? invocation ?? newInvocation(), first?.attempt ?? null);
		for (;;) {
			const left = timeLeft(deadline);
			if (left < 1) return passed();
			const request = {
				host, service, operation: "find", input: page, bound: Math.floor(left),
				...(first === undefined && invocation !== undefined ? { invocation } : {}),
				...(signal === undefined ? {} : { signal }),
			};
			// The page's ending, its fields read once.
			const ending = { ...(await callerInvoke.call(caller, request)) } as CallEnding;
			const address = first ??= { invocation: ending.invocation, attempt: ending.attempt };
			if (ending.ending !== "answered") return Object.freeze({ ...ending, invocation: address.invocation, attempt: address.attempt });
			const form = pageOf(ending.answer);
			// An answer taken once the deadline has passed loses to it, as EM12 has a call's bound win.
			if (now() >= deadline) return passed();
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
		create: (input: JsonInput, o?: WriteOptions) => single("create", input, o, true),
		update: (input: JsonInput, o?: WriteOptions) => single("update", input, o, true),
		delete: (input: JsonInput, o?: WriteOptions) => single("delete", input, o, true),
		read: (input: JsonInput, o?: CallOptions) => single("read", input, o, false),
		findPage: (input: JsonInput, o?: CallOptions) => single("find", input, o, false),
		find,
		historyBound: (o?: CallOptions) => single("history-bound", {}, o, false),
	});
}
