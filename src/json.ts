/**
 * Copies of JSON values: one read once into a fresh value, and one frozen whole, so what entity-api hands
 * an application's policy cannot change what the store is then given. Nothing here is particular to one
 * runtime (zorg's D31).
 */

/**
 * Reads a value once into a fresh JSON value - each property read exactly once - or gives undefined when it
 * is not one: a function, a symbol, undefined, a number that is not finite, an object that is not plain, or
 * a cycle. An object reached by two paths is copied each time it is reached.
 */
export function copyJsonOnce(value: unknown, path: Set<object> = new Set()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "object") return undefined;
	if (path.has(value)) return undefined;
	path.add(value);
	try {
		if (Array.isArray(value)) {
			const copy: unknown[] = [];
			for (let i = 0; i < value.length; i++) {
				const item = copyJsonOnce(value[i], path);
				if (item === undefined) return undefined;
				copy.push(item);
			}
			return copy;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const copy: { [name: string]: unknown } = {};
		for (const name of Object.keys(value)) {
			const item = copyJsonOnce((value as { [name: string]: unknown })[name], path);
			if (item === undefined) return undefined;
			Object.defineProperty(copy, name, { value: item, enumerable: true, writable: true, configurable: true });
		}
		return copy;
	} finally {
		path.delete(value);
	}
}

/** A copy of a JSON value, frozen at every level. */
export function frozenCopy<T>(value: T): T {
	const copy = copyJsonOnce(value);
	if (copy === undefined) throw new TypeError("a value entity-api copies must be a JSON value");
	return deepFreeze(copy) as T;
}

function deepFreeze(value: unknown): unknown {
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}
