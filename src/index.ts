/**
 * Public surface of entity-api: exactly the capabilities CONTRACT.md lists, and nothing else.
 * serveStore - the host half: serve-store-by-name, ask-application-policy and host-named-writer, giving the
 *   policy and the writer naming peer-identity-evidence, and serving the store's carried rows remotely.
 * createStoreClient - the client half: local-like-client, with the store's carried rows and operation-call's
 *   honest-call-ending, caller-chosen-bound and advertiser-instance-select, the whole find of EM10 and the
 *   whole changes of EM16.
 * follow-narrowed-set and follow-closes-with-call are served by both halves (zorg's Delta 4, stage 7; EM18):
 *   serveStore's follow, in parts under its maxFollows, and the client's follow.
 * dated-local-view is deferred (zorg's D15).
 */
export { serveStore, type ApplicationPolicy, type CallerEvidence, type PolicyQuestion, type PolicyRuling, type StoreServer, type StoreServerOptions, type StoreServing, type WriterNaming } from "./host.js";
export { createStoreClient, type CallOptions, type ChangesEnding, type FindEnding, type FollowOptions, type FollowPart, type StoreClient, type StoreClientOptions, type WholeEnding, type WriteOptions } from "./client.js";
export type { StoreOperation, WriteOperation } from "./store-operations.js";
