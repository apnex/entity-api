/**
 * Snapshots of JSON values: one read once into a fresh value, and one frozen whole, so what entity-api hands
 * an application's policy cannot change what the store is then given, and what a whole find sends is what
 * its caller gave when it was called (zorg's target, EM10, EM13). Every walk keeps its own stack rather than
 * recursing, so a value of any depth a caller can build is walked to the end - an over-deep input then
 * reaches the call layer, which refuses it as not sendable - instead of overflowing the runtime's call
 * stack. This follows operation-call's `snapshotJson` and entity-store's walkers, without importing them
 * (zorg's BL19). Nothing here is particular to one runtime (zorg's D31).
 */

/** A member read once: its value, or what reading it threw. */
export type MemberRead = { readonly threw: false; readonly value: unknown } | { readonly threw: true; readonly error: unknown };

/**
 * What `meet` made of an object or function it was shown: taken, so it is not JSON and is not walked into; or
 * passed, with its `then` as `meet` read it, from which the walk takes that member rather than reading it again.
 */
export type Meeting = { readonly taken: true } | { readonly taken: false; readonly then: MemberRead };

/**
 * Reads a value once into a fresh JSON value, or gives undefined when it is not one: a function, a symbol,
 * undefined, a number that is not finite, an array with a hole, an object that is not plain, or a value
 * holding itself. Each member is read exactly once: an object reached by more than one path is read the
 * first time only, its completed copy kept by the object's identity and given again at every later
 * reference, while the containers still being copied are tracked apart, so a value holding itself is still
 * not JSON. A getter or a proxy that throws throws from here, for the caller of this function to contain.
 *
 * Given `meet`, every object and function the walk comes to is shown to it once, by identity, before it is
 * judged - each member as soon as it is read, before the next member is read, so a getter that throws later
 * cannot strand an item already read - and the walk goes on to the end, past whatever is not JSON, so nothing
 * within the value goes unmet; an item `meet` takes is not JSON and is not walked into, and the snapshot is
 * still undefined when any part was not JSON. An item `meet` passes is walked with its `then` member taken
 * from what `meet` read, never read again (EM10, EM13). Without it, the walk stops at the first part that is
 * not JSON.
 */
export function snapshotJson(value: unknown, meet?: (item: object) => Meeting): unknown {
	interface Slot { readonly value: unknown; readonly store: (copy: unknown) => void }
	interface Exit { readonly item: object; readonly copy: unknown; readonly depth: number }
	let result: unknown;
	const stack: Slot[] = [{ value, store: (copy) => { result = copy; } }];
	// The containers being copied above the current slot, so a value holding itself is found.
	const open = new Set<object>();
	// The containers whose copies are complete, so one reached again is given its first copy, not read again.
	const done = new Map<object, unknown>();
	const exits: Exit[] = [];
	// Set when a part is not JSON while `meet` keeps the walk going to the end.
	let refused = false;
	// What `meet` made of each item it was shown, so an item reached again is not shown, nor its `then` read, again.
	const meetings = new Map<object, Meeting>();
	/** Shows an item to `meet` the first time it is reached; undefined without `meet`. */
	const meetOnce = (item: object): Meeting | undefined => {
		if (meet === undefined) return undefined;
		let meeting = meetings.get(item);
		if (meeting === undefined) {
			meeting = meet(item);
			meetings.set(item, meeting);
		}
		return meeting;
	};
	while (stack.length > 0) {
		// Every container whose members have all been copied leaves the open path and becomes done.
		while (exits.length > 0 && (exits.at(-1) as Exit).depth >= stack.length) {
			const exit = exits.pop() as Exit;
			open.delete(exit.item);
			done.set(exit.item, exit.copy);
		}
		const { value: item, store } = stack.pop() as Slot;
		if (item === null || typeof item === "boolean" || typeof item === "string") {
			store(item);
			continue;
		}
		if (typeof item === "number") {
			if (!Number.isFinite(item)) {
				if (meet === undefined) return undefined;
				refused = true;
				continue;
			}
			store(item);
			continue;
		}
		const meeting = typeof item === "object" || typeof item === "function" ? meetOnce(item) : undefined;
		if (meeting?.taken === true) {
			refused = true;
			continue;
		}
		if (typeof item !== "object") {
			if (meet === undefined) return undefined;
			refused = true;
			continue;
		}
		if (done.has(item)) {
			store(done.get(item));
			continue;
		}
		if (open.has(item)) {
			if (meet === undefined) return undefined;
			refused = true;
			continue;
		}
		const members: [string | number, unknown][] = [];
		/** Holds a member just read, showing it to `meet` first, before any further member is read. */
		const hold = (key: string | number, member: unknown): void => {
			if (member !== null && (typeof member === "object" || typeof member === "function") && meetOnce(member)?.taken === true) {
				refused = true;
				return;
			}
			members.push([key, member]);
		};
		let copy: unknown[] | { [name: string]: unknown };
		if (Array.isArray(item)) {
			const length = item.length;
			for (let i = 0; i < length; i++) {
				if (!(i in item)) {
					if (meet === undefined) return undefined;
					refused = true;
					continue;
				}
				hold(i, item[i]);
			}
			copy = new Array<unknown>(length);
		} else {
			const prototype = Object.getPrototypeOf(item);
			if (prototype !== Object.prototype && prototype !== null) {
				if (meet === undefined) return undefined;
				refused = true;
				continue;
			}
			for (const name of Object.keys(item)) {
				// The `then` member as `meet` read it, when it did; it is not read again.
				const then = name === "then" && meeting?.taken === false ? meeting.then : undefined;
				if (then?.threw === true) throw then.error;
				hold(name, then !== undefined ? then.value : (item as { [name: string]: unknown })[name]);
			}
			copy = {};
		}
		store(copy);
		open.add(item);
		exits.push({ item, copy, depth: stack.length });
		const target = copy as { [key: string | number]: unknown };
		for (let i = members.length - 1; i >= 0; i--) {
			const [key, member] = members[i] as [string | number, unknown];
			stack.push({ value: member, store: (c) => { Object.defineProperty(target, key, { value: c, enumerable: true, writable: true, configurable: true }); } });
		}
	}
	return refused ? undefined : result;
}

/** A snapshot of a JSON value, frozen at every level; throws a TypeError when the value is not JSON. */
export function frozenSnapshot<T>(value: T, what = "a value entity-api copies"): T {
	const copy = snapshotJson(value);
	if (copy === undefined) throw new TypeError(`${what} must be a JSON value`);
	return deepFreeze(copy) as T;
}

/** Freezes a fresh JSON value at every level, with its own stack; a copy shared by two references is frozen once. */
function deepFreeze(value: unknown): unknown {
	const stack: unknown[] = [value];
	while (stack.length > 0) {
		const item = stack.pop();
		if (item === null || typeof item !== "object" || Object.isFrozen(item)) continue;
		Object.freeze(item);
		for (const member of Object.values(item)) stack.push(member);
	}
	return value;
}
