---
id: unminted
category: component
title: entityapi - an entity store reached by name, with its guarantees intact
status: draft
hydrate-when: An application must use an entity store it does not host, and must not lose the store's guarantees across the network
sovereignty: internal
supersedes: []
related: [C0, A3]
---

# entityapi

Draft registry entry, written before any consumer's architecture so that its contract states the whole offer.\
The id is unminted on purpose; one is minted only when the entry is admitted to the registry.

---

## Duty

Make an entity store reachable by name, so a remote caller can rely on exactly what a local one can.

---

## Contract

What a consumer can depend on.\
Each row is one feature; the census counts rows, and the trait column names any trait a system takes on by using the feature.

| Feature | What a consumer can depend on | Trait |
|---|---|---|
| `entityapi.host` | A host half serves one store's operations as named operations, under a name the application chooses. | none |
| `entityapi.client` | A client half offers the store's operations to application logic as if the store were local. | none |
| `entityapi.position` | Every answer carries the position the store gave it. | none |
| `entityapi.follow` | A remote follow arrives once and in order, reports entities entering, changing within and leaving the narrowed set, and closes when the call carrying it ends. | none |
| `entityapi.repeat` | A writer's identity crosses the network, so the store still recognises a repeated write. | none |
| `entityapi.conflict` | An expected revision crosses the network, and a conflict returns as a refusal with its reason. | none |
| `entityapi.policy` | Before each operation the host asks the application whether the caller may act, passing the caller's evidence; it never decides. | none |
| `entityapi.dated-view` | The client half may keep a local view, which always states the position it reflects. | none |
| `entityapi.host-naming` | A caller names the host it means, so another host claiming the same store cannot answer in its place. | none |

**Traits.**\
The component holds only the streams open now, so it is not stateful.\
A dated local view is a cache the store can always correct, so by `T1`'s own boundary it brings no trait.\
The host half only makes sense beside a store: the system running it contains that store and takes on its traits, while a system using only the client half composes with the store across the contract and does not.

---

## Reference

Not yet built.\
Vision: `entityapi/VISION.md` in the zorg repository, which will hold the implementation until the component earns a repository of its own.

---

## Fit criteria

### Does my project want this at all

- An application shares an entity store with processes or machines that do not host it.
- You are about to write an operation per store action, pass positions through, make writes safe to repeat, or close follows when a watcher goes.
- A remote caller acts on what it reads and must not lose the store's currency or ordering.

### Does it meet my requirement

- The store is reached by name, never by address.
- Every guarantee the store makes holds for a remote caller, checked by running the store's own guarantee checks through entityapi.
- The application keeps its kinds and its rules about who may do what.

**It is the wrong tool when**

| You need | Reach elsewhere, because entityapi is |
|---|---|
| a second store kept in step with the first | not a replicator |
| a record of who followed and how far they got | not a keeper of watchers |
| commands, screens or wording | not a user interface |
| reply pairing, time-outs or parts | not the call layer; that is opcall |
| a decision about who may act | not an authority |

---

## Adjustment policy

Internal and sovereign, so a fit gap has somewhere to go.

1. Record a measured gap where both sides can see it.
2. Resolve it by adjusting entityapi, so every consumer gets the change, or by fracturing it when the gap reveals a second duty.
3. Never fork.

New store operations reach entityapi through entitystore's contract, so a feature added to the store is served by adding it to that contract rather than by a change specific to one application.

---

## Edges

**Composes:** nothing registered.\
Its host half and client half are halves of one duty, not separate components.

**Consumes, through a declared contract:**

- entitystore - every feature, through the host half.
- opcall - `opcall.invoke`, `opcall.bound`, `opcall.parts`, `opcall.cancel`, `opcall.identity`, `opcall.serve`, `opcall.caller-evidence` and `opcall.instance`.

**Composed-by:** nothing yet.\
zorg is the first consumer.

The registry's edge vocabulary has no edge for one component using another's contract without containing it; see the note in opcall's entry.
