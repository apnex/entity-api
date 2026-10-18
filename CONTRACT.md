---
id: unminted
category: component
title: entity-api - an entity store reached by name, with its guarantees intact
status: draft
hydrate-when: An application must use an entity store it does not host, and must not lose the store's guarantees across the network
sovereignty: internal
supersedes: []
related: [C0, A3]
---

# entity-api

The contract of record for entity-api: what a consumer can depend on, written before any consumer's architecture so that it states the whole offer.\
It also carries the fields of a mission-kit registry entry, and that entry is generated from this file when the component is filed, never written as a second copy.\
The registry id is unminted on purpose; one is minted only when the entry is admitted to the registry.

---

## Duty

Make an entity store reachable by name, so a remote caller can rely on exactly what a local one can.

---

## Contract

What a consumer can depend on, one capability per row.\
A capability is named for what it offers, not for who offers it, so two components that provide the same capability share its name, and the overlap is visible.\
**Provides** means this component implements the capability; **carries from X** means it passes X's capability through its own interface.\
**Requires** names the capabilities of other components a row depends on, as `component:capability`, so a census can follow an application's demand down through the components it reaches.\
The trait column names any trait a system takes on by using the capability.

| Capability | Relation | Requires | What a consumer can depend on | Trait |
|---|---|---|---|---|
| `serve-store-by-name` | provides | `operation-call:serve-named-operations`, `operation-call:operation-descriptions`, `operation-call:declared-shape-validation`, `operation-call:call-refusal` | A host half serves one store's operations as named operations, under a name the application chooses. | none |
| `local-like-client` | provides | `operation-call:honest-call-ending`, `operation-call:caller-chosen-bound`, `operation-call:invocation-identity`, `operation-call:request-correlation`, `shape-check:plain-json-value` | A client half offers the store's operations to application logic as if the store were local. | none |
| `follow-closes-with-call` | provides | `operation-call:answer-in-parts`, `operation-call:cancel-invocation` | A remote follow ends only when the call carrying it ends - a caller ends it by cancelling that call - and the watcher resumes from its own position. | none |
| `host-named-writer` | provides | `operation-call:peer-identity-evidence`, `shape-check:plain-json-value` | On the host half, the writer recorded for each remote change is the one the application names from the caller's evidence; a writer the client claims is never recorded. | none |
| `ask-application-policy` | provides | `operation-call:peer-identity-evidence`, `operation-call:call-refusal`, `shape-check:plain-json-value` | Before each operation the host asks the application whether the caller may act; it never decides. | none |
| `dated-local-view` | provides | none | The client half may keep a local view, which always states the position it reflects. | none |
| `positioned-entity-write` | carries from entity-store | none | Each remote change takes one position in the store's order. | none |
| `change-provenance` | carries from entity-store | none | Remote readers see when each change was made and the writer the host named. | none |
| `stated-history-bound` | carries from entity-store | none | A remote reader can read the store's history bound, and a reader behind it is told so. | none |
| `expected-revision-write` | carries from entity-store | none | An expected revision crosses the network, and a conflict returns as a refusal with its reason. | none |
| `repeat-recognition` | carries from entity-store | none | The client half passes each invocation's identity as the writer's identity, so repeating an invocation repeats the write and the store recognises it. | none |
| `identity-name-lookup` | carries from entity-store | none | Remote reads by identity or name, each with the store's position. | none |
| `find-by-kind-tags` | carries from entity-store | none | Remote finds by kind and tags, each with the store's position. | none |
| `changes-since-position` | carries from entity-store | none | Remote reads of changes since a position, once and in order. | none |
| `follow-narrowed-set` | carries from entity-store | `operation-call:answer-in-parts`, `operation-call:caller-chosen-bound` | A remote follow reports entities entering, changing within and leaving the narrowed set, once and in order. | none |
| `store-refusal` | carries from entity-store | `operation-call:call-refusal` | The store's refusals arrive with their reasons intact. | none |
| `caller-chosen-bound` | carries from operation-call | none | A remote caller sets each operation's bound: total time for a whole answer, or time to the next sign of life for a follow. | none |
| `honest-call-ending` | carries from operation-call | none | Every remote operation ends honestly, even when the honest answer is unknown. | none |
| `peer-identity-evidence` | carries from operation-call | none | The application's policy check receives the caller's evidence. | none |
| `advertiser-instance-select` | carries from operation-call | none | A caller names the host it means, so another host claiming the same store cannot answer in its place. | none |

**Traits.**\
The component holds only the streams open now, so it is not stateful.\
A dated local view is a cache the store can always correct, so by `T1`'s own boundary it brings no trait.\
The host half only makes sense beside a store: the system running it contains that store and takes on its traits, while a system using only the client half composes with the store across the contract and does not.

---

## Reference

This repository, `apnex/entity-api`, private until its first working code is certified.\
The package `@apnex/entity-api` exports `serveStore`, the host half, and `createStoreClient`, the client half, as `export-map.json` records.\
`changes-since-position` is served by both halves, the host serving `changes` and the client offering `changesPage` and the whole `changes`, built in zorg's Delta 4 under `D64`; `follow-closes-with-call`, `dated-local-view` and `follow-narrowed-set` are deferred under zorg's `D15`.\
It depends on `@apnex/entity-store`, `@apnex/operation-call`, `@apnex/shape-check` and `@agp/node` through `file:` links, takes AGP's and entity-store's types only, and imports no module particular to one runtime.

---

## Fit criteria

### Does my project want this at all

- An application shares an entity store with processes or machines that do not host it.
- You are about to write an operation per store action, pass positions through, make writes safe to repeat, or close follows when a watcher goes.
- A remote caller acts on what it reads and must not lose the store's currency or ordering.

### Does it meet my requirement

- The store is reached by name, never by address.
- Every guarantee the store makes holds for a remote caller, checked by running the store's own guarantee checks through entity-api.
- The application keeps its kinds and its rules about who may do what.

**It is the wrong tool when**

| You need | Reach elsewhere, because entity-api is |
|---|---|
| a second store kept in step with the first | not a replicator |
| a record of who followed and how far they got | not a keeper of watchers |
| commands, screens or wording | not a user interface |
| reply pairing, time-outs or parts | not the call layer; that is operation-call |
| a decision about who may act | not an authority |

---

## Adjustment policy

Internal and sovereign, so a fit gap has somewhere to go.

1. Record a measured gap where both sides can see it.
2. Resolve it by adjusting entity-api, so every consumer gets the change, or by fracturing it when the gap reveals a second duty.
3. Never fork.

New store operations reach entity-api through entity-store's contract, so a capability added to the store is served by adding it to that contract rather than by a change specific to one application.

---

## Edges

**Composes:** nothing registered.\
Its host half and client half are halves of one duty, not separate components.

**Consumes, through a declared contract:**

- `entity-store`: `declared-shape-validation`, `positioned-entity-write`, `change-provenance`, `expected-revision-write`, `repeat-recognition`, `identity-name-lookup`, `find-by-kind-tags`, `changes-since-position`, `follow-narrowed-set`, `stated-history-bound`, `store-refusal`
- `operation-call`: `honest-call-ending`, `caller-chosen-bound`, `answer-in-parts`, `cancel-invocation`, `invocation-identity`, `request-correlation`, `operation-descriptions`, `declared-shape-validation`, `call-refusal`, `serve-named-operations`, `peer-identity-evidence`, `advertiser-instance-select`
- `shape-check`: `plain-json-value`

**Composed-by:** nothing yet.\
Its first consumer is zorg.

The registry's edge vocabulary has no edge for one component using another's contract without containing it; see the note in operation-call's entry.
