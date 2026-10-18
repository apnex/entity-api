/**
 * Public surface of entity-api: exactly the capabilities CONTRACT.md lists, and nothing else.
 * serveStore - the host half: serve-store-by-name, ask-application-policy and host-named-writer, giving the
 *   policy and the writer naming peer-identity-evidence, and serving the store's carried rows remotely.
 * createStoreClient - the client half: local-like-client, with the store's carried rows and operation-call's
 *   honest-call-ending, caller-chosen-bound and advertiser-instance-select, the whole find of EM10 and the
 *   whole changes of EM16.
 * follow-closes-with-call, dated-local-view and follow-narrowed-set are deferred (zorg's D15) until zorg's
 * Delta 4 builds the first and the last.
 */
export { serveStore, type ApplicationPolicy, type CallerEvidence, type PolicyQuestion, type PolicyRuling, type StoreServer, type StoreServerOptions, type StoreServing, type WriterNaming } from "./host.js";
export { createStoreClient, type CallOptions, type ChangesEnding, type FindEnding, type StoreClient, type StoreClientOptions, type WholeEnding, type WriteOptions } from "./client.js";
export type { StoreOperation, WriteOperation } from "./store-operations.js";
