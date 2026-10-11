/**
 * Public surface of entity-api: exactly the capabilities CONTRACT.md lists, and nothing else.
 * serveStore - the host half: serve-store-by-name, ask-application-policy and host-named-writer, giving the
 *   policy and the writer naming peer-identity-evidence, and serving the store's carried rows remotely.
 * createStoreClient - the client half: local-like-client, with the store's carried rows and operation-call's
 *   honest-call-ending, caller-chosen-bound and advertiser-instance-select, and the whole find of EM10.
 * follow-closes-with-call, dated-local-view, changes-since-position and follow-narrowed-set are deferred
 * (zorg's D15).
 */
export { serveStore, type ApplicationPolicy, type CallerEvidence, type PolicyQuestion, type PolicyRuling, type StoreServer, type StoreServerOptions, type StoreServing, type WriterNaming } from "./host.js";
export { createStoreClient, type CallOptions, type FindEnding, type StoreClient, type StoreClientOptions, type WriteOptions } from "./client.js";
export type { StoreOperation, WriteOperation } from "./store-operations.js";
