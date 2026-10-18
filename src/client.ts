/**
 * The client half (zorg's target, EM7, EM10, EM12): the store's operations offered to application logic as
 * if the store were local, each single call at most one invocation of the operation-call caller it is given -
 * operation-call's own caller, or operation-proxy's client half, which offers the same interface - pinned to
 * the host the application names.
 *
 * Each single call - `create`, `read`, `update`, `delete`, `findPage`, `changesPage` and `historyBound` - delegates directly to
 * the call layer's caller (EM10, EM12; zorg's D55): it reads nothing and keeps no clock of its own, but hands
 * the caller one request whose option getters read the application's options, each at most once, only when
 * the caller reads them - which operation-call's caller does after reading its clock - the bound defaulting to
 * the client's, the repeat flag forwarded for a write only, and the invocation and the signal when given. So
 * the call layer owns the clock reading, the reads of the options and the input, the programming errors, the
 * `bound-passed` ending with its made attempt identity, and the invocation, and the ending is the call
 * layer's, unchanged. A write's identity is its invocation identity: the client never writes a writer or a
 * write identity into an input, and an application repeats a write by repeating its invocation (EM7,
 * `repeat-recognition`).
 *
 * `find` is the whole find of EM10, the client's own aggregate operation: it reads its clock as it is called,
 * then its input and options once, the input through shape-check's `snapshotJson`, and answers every match,
 * `{position, entries}`, read page by page as of the first page's position within one deadline; `findPage` is
 * one page, exactly as the store answers it. `changes` is the whole `changes` of EM16, run as the whole find
 * is, each later page asked since the previous page's `next`, and answering every item, `{position, changes}`,
 * with the last page's position; `changesPage` is one page, exactly as the store answers it. Nothing here
 * is particular to one runtime (zorg's D31): time and randomness come from the ports it is given, by default
 * operation-call's.
 */
import {
	systemCallClock,
	systemIdentitySource,
	MAX_BOUND_MS,
	type CallClock,
	type CallEnding,
	type CallRequest,
	type IdentitySource,
	type JsonInput,
	type JsonValue,
	type OperationCaller,
} from "@apnex/operation-call";
import { isInvocationId, NAME_PATTERN } from "@apnex/operation-call/message-format";
import { snapshotJson } from "@apnex/shape-check";
import type { StoreOperation } from "./store-operations.js";

/** What a client is built from. */
export interface StoreClientOptions {
	/**
	 * The caller every call the client sends is invoked through: operation-call's caller, or anything offering
	 * its interface. A whole find whose bound passed while it read its input and options hands it no page.
	 */
	readonly caller: OperationCaller;
	/** The AGP node of the host the application means; every call is pinned to it (`advertiser-instance-select`). */
	readonly host: string;
	/** The name the store is reached by, matching EM1's pattern. */
	readonly service: string;
	/** The bound of any call that names none, in whole milliseconds from 1 to 2147483647; none when absent. */
	readonly bound?: number;
	/**
	 * The clock a whole find's one deadline is kept on, read as the find is called, before each page is invoked
	 * and as each page's answer is accepted - so give the caller's own; a single call keeps no clock, the call
	 * layer's caller keeping its own. operation-call's default when absent.
	 */
	readonly clock?: CallClock;
	/**
	 * Where the client takes the invocation identity of the one ending it gives itself, having sent nothing: a
	 * whole find's whose bound passed before any page was sent, when none was given. operation-call's default
	 * when absent.
	 */
	readonly identities?: IdentitySource;
}

/** What each call may name. */
export interface CallOptions {
	/**
	 * The call's bound, in whole milliseconds from 1 to 2147483647. A single call hands it to the call layer,
	 * whose caller starts it as it reads its clock, before it reads this option. A whole find's starts when the
	 * find is called, the time it takes reading its input and options spent from it, and gives each page the
	 * time left when that page is invoked; with less than 1 millisecond left no page is sent, and the find ends
	 * unknown with `bound-passed`. A bound out of range or not whole is thrown, whatever the time.
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
 * How a whole find or a whole `changes` ends (EM10, EM16): as its last page ended, through whatever caller the
 * client was given - so every ending the caller interface admits, a caller across a hop's included (EM12) -
 * under its first page's identity.
 */
export type WholeEnding = FindEndingOf<CallEnding>;

/** How a whole find ends (EM10). */
export type FindEnding = WholeEnding;

/** How a whole `changes` ends (EM16). */
export type ChangesEnding = WholeEnding;

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
	/** One page of changes, answered `{position, changes, next}` exactly as the store answers it (EM16). */
	changesPage(input: JsonInput, options?: CallOptions): Promise<CallEnding>;
	/** The whole `changes`: every change since a position, answered `{position, changes}`, within one deadline (EM16). */
	changes(input: JsonInput, options?: CallOptions): Promise<ChangesEnding>;
}

/** Throws unless a bound is a whole number of milliseconds from 1 to 2147483647 (EM12). */
function checkBound(bound: unknown): number {
	if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 1 || bound > MAX_BOUND_MS) {
		throw new RangeError("a call's bound is a whole number of milliseconds from 1 to 2147483647");
	}
	return bound;
}

/** The message of a call's options that are neither an object nor absent. */
const NOT_OPTIONS = "a call's options are an object: { bound, invocation, signal }";

/**
 * Reads a whole find's options, which are an object or absent, once, into a snapshot: the bound, the
 * invocation and the signal are each read exactly once, now, and never again, so no getter of the caller's
 * runs once the find is under way (EM10).
 */
function optionsOf(options: CallOptions | undefined): Partial<CallOptions> {
	if (options === undefined) return {};
	if (options === null || typeof options !== "object") throw new TypeError(NOT_OPTIONS);
	const bound = options.bound;
	const invocation = options.invocation;
	const signal = options.signal;
	return {
		...(bound === undefined ? {} : { bound }),
		...(invocation === undefined ? {} : { invocation }),
		...(signal === undefined ? {} : { signal }),
	};
}

/**
 * A whole find as begun (EM10): its deadline on the client's clock, and the snapshot of its input and of the
 * options it takes, read once and checked.
 */
interface Begun {
	readonly deadline: number;
	readonly input: JsonValue;
	readonly invocation?: string;
	readonly signal?: AbortSignal;
}

/** One option as a single call's request read it: its value, or what reading it threw. */
type OptionRead = { readonly threw: false; readonly value: unknown } | { readonly threw: true; readonly error: unknown };

/** A page's answer as a whole paged operation reads it, its fields read once: its position, its items and its `next`. */
interface PageForm<Next> { readonly position: number; readonly items: readonly JsonValue[]; readonly next: Next | null }

/** True for a whole number: a safe integer from 0. */
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Each element of an array, read once, by index. */
function itemsOf(list: readonly unknown[]): JsonValue[] {
	const held: JsonValue[] = [];
	const length = list.length;
	for (let i = 0; i < length; i++) held.push(list[i] as JsonValue);
	return held;
}

/**
 * Recognises a page of a find (EM10): an object holding a `position` that is a whole number, an `entries` array
 * and a `next` that is a name or null. Each field, and each entry, is read once, so nothing of the answer is
 * read after the find has read its clock.
 */
function findPageOf(answer: unknown): PageForm<string> | undefined {
	if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return undefined;
	const { position, entries, next } = answer as { position?: unknown; entries?: unknown; next?: unknown };
	if (!isWhole(position)) return undefined;
	if (!Array.isArray(entries)) return undefined;
	if (next !== null && (typeof next !== "string" || !NAME_PATTERN.test(next))) return undefined;
	return { position, items: itemsOf(entries), next };
}

/**
 * Recognises a page of changes (EM16): an object holding a `position` that is a whole number, a `changes`
 * array, and a `next` that is null or a whole number above the `since` the page was asked with and not above
 * the page's `position`, so every page a whole `changes` takes moves it forward. Each field, and each item, is
 * read once; the `since` is read from the input the client itself sent, plain data it holds.
 */
function changesPageOf(answer: unknown, asked: JsonValue): PageForm<number> | undefined {
	if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return undefined;
	const { position, changes, next } = answer as { position?: unknown; changes?: unknown; next?: unknown };
	if (!isWhole(position)) return undefined;
	if (!Array.isArray(changes)) return undefined;
	if (next !== null) {
		const since = asked !== null && typeof asked === "object" && !Array.isArray(asked) ? (asked as { readonly since?: JsonValue }).since : undefined;
		if (!isWhole(next) || typeof since !== "number" || next <= since || next > position) return undefined;
	}
	return { position, items: itemsOf(changes), next };
}

/** What makes a whole paged operation of the client's - the whole find or the whole `changes` - its own. */
interface Paging<Next> {
	readonly operation: "find" | "changes";
	/** The page an answer is, or undefined when it is not one; `asked` is the input the page was asked with. */
	read(answer: unknown, asked: JsonValue): PageForm<Next> | undefined;
	/** The input of the page after `last`, the first page being `first`. */
	following(query: JsonValue, first: PageForm<Next>, last: PageForm<Next> & { readonly next: Next }): JsonInput;
	/** The answer once a page answers with `next` null: every page's items, in order. */
	finish(first: PageForm<Next>, last: PageForm<Next>, items: readonly JsonValue[]): JsonValue;
}

/** The whole find (EM10): each later page as of the first page's position and after the last page's `next`, answered with the first page's position. */
const FIND: Paging<string> = {
	operation: "find",
	read: (answer) => findPageOf(answer),
	following: (query, first, last) => ({ ...(query as { [name: string]: JsonValue }), asOf: first.position, after: last.next }),
	finish: (first, _last, items) => Object.freeze({ position: first.position, entries: Object.freeze(items) as unknown as JsonValue[] }),
};

/** The whole `changes` (EM16): each later page since the last page's `next`, answered with the last page's position. */
const CHANGES: Paging<number> = {
	operation: "changes",
	read: (answer, asked) => changesPageOf(answer, asked),
	following: (query, _first, last) => ({ ...(query as { [name: string]: JsonValue }), since: last.next }),
	finish: (_first, last, items) => Object.freeze({ position: last.position, changes: Object.freeze(items) as unknown as JsonValue[] }),
};

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

	/** Reads the deadline's clock; a reading that is not a finite number is a fault of the port. */
	const now = (): number => {
		const reading: unknown = clockNow.call(clock);
		if (typeof reading !== "number" || !Number.isFinite(reading)) throw new TypeError(`the client's clock read ${String(reading)}, not a finite number of milliseconds`);
		return reading;
	};

	/**
	 * Begins a whole find (EM10, EM12): the clock is read first, before anything else, then the options and the
	 * input are each read once, into a snapshot - the input through shape-check's `snapshotJson` - and checked,
	 * so a programming error is thrown whatever the time. The find's deadline is that first reading plus the
	 * bound, so the time the snapshot takes is spent from the bound.
	 */
	const begin = (input: JsonInput, call: CallOptions | undefined): Begun => {
		const start = now();
		const given = optionsOf(call);
		const bound = checkBound(given.bound === undefined ? options.bound : given.bound);
		if (given.invocation !== undefined && !isInvocationId(given.invocation)) throw new TypeError("a call's invocation must be an invocation identity as EM11 writes it");
		const signal: unknown = given.signal;
		if (signal !== undefined && (signal === null || typeof (signal as { aborted?: unknown }).aborted !== "boolean")) throw new TypeError("a call's signal must be an AbortSignal");
		let snapshot: ReturnType<typeof snapshotJson>;
		try {
			snapshot = snapshotJson(input);
		} catch (error) {
			throw new TypeError("a call's input could not be read as a JSON value", { cause: error });
		}
		if (!snapshot.ok) throw new TypeError("a call's input must be a JSON value");
		return {
			deadline: start + bound,
			input: snapshot.value,
			...(given.invocation === undefined ? {} : { invocation: given.invocation }),
			...(given.signal === undefined ? {} : { signal: given.signal }),
		};
	};

	/** The time left until a call's deadline, read now, so it is read immediately before the call layer is invoked. */
	const timeLeft = (deadline: number): number => deadline - now();

	/**
	 * Whether a page's answer, already observed, came once the find's deadline had passed. A reading that throws
	 * is a fault of the port and cannot show that the deadline passed, so the answer observed decides (EM12).
	 */
	const shownLate = (deadline: number): boolean => {
		try {
			return now() >= deadline;
		} catch {
			return false;
		}
	};

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

	/**
	 * A single call (EM10, EM12; zorg's D55): delegated directly to the call layer's caller as one invocation, its
	 * ending the caller's, unchanged. The request holds the host, the service, the operation and the input as
	 * given, and getters of `bound`, `invocation`, `signal` and, for a write only, `repeat`, each reading the
	 * application's option of that name at most once, when the caller first reads it - operation-call's caller
	 * reads its clock first - and giving the same value, or the same throw, at every later read. The bound
	 * defaults to the client's; options that are neither an object nor absent throw a TypeError as an option is
	 * read. Nothing is read, checked or timed here: the call layer owns all of it.
	 */
	const single = async (operation: StoreOperation, input: JsonInput, call: WriteOptions | undefined, repeatable: boolean): Promise<CallEnding> => {
		const reads = new Map<string, OptionRead>();
		/** The application's option `name`, read at most once. */
		const option = (name: "bound" | "invocation" | "signal" | "repeat"): unknown => {
			let read = reads.get(name);
			if (read === undefined) {
				try {
					if (call !== undefined && (call === null || typeof call !== "object")) throw new TypeError(NOT_OPTIONS);
					read = { threw: false, value: call === undefined ? undefined : call[name] };
				} catch (error) {
					read = { threw: true, error };
				}
				reads.set(name, read);
			}
			if (read.threw) throw read.error;
			return read.value;
		};
		const request = { host, service, operation, input } as { -readonly [K in keyof CallRequest]: CallRequest[K] };
		const getter = (name: "bound" | "invocation" | "signal" | "repeat", get: () => unknown): void => {
			Object.defineProperty(request, name, { get, enumerable: true, configurable: false });
		};
		getter("bound", () => {
			// Only an absent bound defaults to the client's; any bound given, null included, goes to the call layer's check (EM12).
			const bound = option("bound");
			return bound === undefined ? options.bound : bound;
		});
		getter("invocation", () => option("invocation"));
		if (repeatable) getter("repeat", () => option("repeat"));
		getter("signal", () => option("signal"));
		return callerInvoke.call(caller, Object.freeze(request));
	};

	/**
	 * A whole paged operation - the whole find of EM10, or the whole `changes` of EM16, which runs as it does: its
	 * clock is read as it is called, before anything else, as every caller reads its own (EM12); then its input
	 * and options are read once, into a snapshot, and its one deadline is that first reading plus the bound, so the
	 * time the snapshot takes is spent from the bound. Each page is invoked with the time left, read immediately
	 * before that page is invoked and rounded down to a whole millisecond, as its bound, so no getter of the
	 * caller's runs between that reading and the invocation; no page is sent with less than 1 millisecond left -
	 * the first included, when preparing used the bound up, the operation then ending with attempt null, as no
	 * page was sent - and no answered page is taken once the deadline has passed - shown by a reading taken as its
	 * answer is accepted; a reading that throws then cannot show it, so the answer observed decides, while one
	 * that throws before a page is sent is thrown. A page ending other than answered ends the operation as that
	 * page ended, whenever it is observed (step 5). The first page goes under the identity given, or a new one,
	 * each later page under a new identity, its input as the operation's `following` makes it; none is marked a
	 * repeat, and the signal given reaches each. A page whose answer is not a page ends the operation answered
	 * with that answer unchanged. Every ending is the caller's, unchanged but for the first page's invocation and
	 * attempt.
	 */
	const whole = async <Next>(paging: Paging<Next>, input: JsonInput, call?: CallOptions): Promise<WholeEnding> => {
		const { deadline, input: query, invocation, signal } = begin(input, call);
		let first: { readonly invocation: string; readonly attempt: string | null } | undefined;
		let firstPage: PageForm<Next> | undefined;
		const items: JsonValue[] = [];
		let page = query as JsonInput;
		const passed = (): WholeEnding => boundPassed(paging.operation, first?.invocation ?? invocation ?? newInvocation(), first?.attempt ?? null);
		for (;;) {
			const left = timeLeft(deadline);
			if (left < 1) return passed();
			const request = {
				host, service, operation: paging.operation, input: page, bound: Math.floor(left),
				...(first === undefined && invocation !== undefined ? { invocation } : {}),
				...(signal === undefined ? {} : { signal }),
			};
			// The page's ending, its fields read once.
			const ending = { ...(await callerInvoke.call(caller, request)) } as CallEnding;
			const address = first ??= { invocation: ending.invocation, attempt: ending.attempt };
			if (ending.ending !== "answered") return Object.freeze({ ...ending, invocation: address.invocation, attempt: address.attempt });
			const form = paging.read(ending.answer, page as JsonValue);
			// An answer taken once the deadline has passed loses to it, as EM12 has a call's bound win.
			if (shownLate(deadline)) return passed();
			if (form === undefined) return Object.freeze({ ...ending, invocation: address.invocation, attempt: address.attempt });
			firstPage ??= form;
			for (const item of form.items) items.push(item);
			if (form.next === null) {
				return Object.freeze({
					ending: "answered", invocation: address.invocation, attempt: address.attempt, operation: paging.operation,
					answer: paging.finish(firstPage, form, items),
				});
			}
			page = paging.following(query, firstPage, form as PageForm<Next> & { readonly next: Next });
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
		find: (input: JsonInput, o?: CallOptions) => whole(FIND, input, o),
		historyBound: (o?: CallOptions) => single("history-bound", {}, o, false),
		changesPage: (input: JsonInput, o?: CallOptions) => single("changes", input, o, false),
		changes: (input: JsonInput, o?: CallOptions) => whole(CHANGES, input, o),
	});
}
