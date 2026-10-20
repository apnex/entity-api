/**
 * The operations a store is served under, and their input shapes, exactly as zorg's target declares them
 * (EM10, EM16, EM18): the same eight for any store, `follow` answering in parts, each its own AGP endpoint `<name>/<operation>`, each input shape a
 * shape document in shape-check's dialect. No input shape admits a `writer` or a write identity, so a remote
 * input carrying either is refused by operation-call as `input-misfit` before the store sees it (EM7, EM10).
 * Nothing here is particular to one runtime (zorg's D31).
 */

/** shape-check's dialect identifier (zorg's D19), which every shape document declares. */
const DIALECT = "urn:apnex:shape-check:dialect:1";

/** The operations entity-api serves for any store (EM10, EM16, EM18). */
export type StoreOperation = "create" | "update" | "delete" | "read" | "find" | "history-bound" | "changes" | "follow";

/** The operations that write, each handled in EM13's synchronous order. */
export type WriteOperation = "create" | "update" | "delete";

/** Every operation served, in the order EM10's table lists them. */
export const STORE_OPERATIONS: readonly StoreOperation[] = Object.freeze(["create", "update", "delete", "read", "find", "history-bound", "changes", "follow"]);

/** True for an operation that writes. */
export function isWrite(operation: StoreOperation): operation is WriteOperation {
	return operation === "create" || operation === "update" || operation === "delete";
}

const target = () => ({ type: "object", additionalProperties: false, properties: { id: { type: "string" }, kind: { type: "string" }, name: { type: "string" } } });
const tags = () => ({ type: "array", items: { type: "string" } });

/** A shape document of EM10, by operation, written fresh each time so no caller can change another's copy. */
export function inputShape(operation: StoreOperation): { [name: string]: unknown } {
	switch (operation) {
		case "create":
			return { $schema: DIALECT, type: "object", required: ["kind", "name", "tags", "body"], additionalProperties: false,
				properties: { kind: { type: "string" }, name: { type: "string" }, tags: tags(), body: {} } };
		case "update":
			return { $schema: DIALECT, type: "object", required: ["target"], additionalProperties: false,
				properties: { target: target(), expectedRevision: { type: "integer" }, name: { type: "string" }, tags: tags(), body: {} } };
		case "delete":
			return { $schema: DIALECT, type: "object", required: ["target"], additionalProperties: false,
				properties: { target: target(), expectedRevision: { type: "integer" } } };
		case "read":
			return { $schema: DIALECT, type: "object", required: ["target"], additionalProperties: false, properties: { target: target() } };
		case "find":
			return { $schema: DIALECT, type: "object", required: ["kind"], additionalProperties: false,
				properties: { kind: { type: "string" }, tags: tags(), after: { type: "string" }, asOf: { type: "integer" } } };
		case "history-bound":
			return { $schema: DIALECT, type: "object", additionalProperties: false };
		case "changes":
			return { $schema: DIALECT, type: "object", required: ["since"], additionalProperties: false, properties: { since: { type: "integer" } } };
		case "follow":
			// Small however long a follow is held (EM18): a kind of at most 63 characters, at most 32 tags of at most 127.
			return { $schema: DIALECT, type: "object", required: ["kind", "since"], additionalProperties: false,
				properties: { kind: { type: "string", maxLength: 63 }, tags: { type: "array", maxItems: 32, items: { type: "string", maxLength: 127 } }, since: { type: "integer" } } };
	}
}
