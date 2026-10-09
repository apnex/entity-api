# entityapi - Vision

**Status: ratified by the director, 2026-10-09 (zorg's `docs/DECISIONS.md`, `D5`); enduring.**\
This document states why entityapi exists and what it will never be.\
It carries no current state, no roadmap, and no schedule.

Holding this document authorises nothing.\
It does not ratify a decision, admit a component to any registry, or approve a contract change.\
A change of direction is recorded as a decision first and absorbed here afterwards.

---

## North star

> Let any application work with an entity store it does not host - reach it by name from anywhere; find, change, and follow its entities - and lose none of the store's guarantees on the way.

Four terms in that sentence carry weight, so this document defines them rather than leaving them to the reader.

**Work with** means create, read, list, update, delete, and follow.

**Does not host** means the store runs in another process, perhaps on another machine.

**Reach it by name** means the store is addressed by what it is, never by where it runs.

**None of the store's guarantees** means all of these survive the network:

- every answer says how current it is;
- a reader can learn how far back the store keeps history;
- followed changes arrive once and in order, including an entity leaving a followed set;
- a repeated write is recognised;
- a write that would overwrite an unseen change is refused, with its reason;
- every call ends honestly, even when the honest answer is unknown.

---

## Why it exists

A store that only its own process can reach serves one program.\
A shared store must be reachable, and every application that shares one writes the same layer: an operation per action, positions passed through, writes made safe to repeat, follows closed when the watcher goes.

Each one loses a guarantee somewhere.\
It drops the position, retries a write blindly, or never tells a watcher that an entity left its set.\
The store was exact; the copy of it across the network was not.

entityapi writes that layer once, so the guarantees cross the network intact.

---

## What it is

Two halves.\
A host half sits beside a store and serves it as named operations.\
A client half is called by application logic, or by a command-line tool built on it, as if the store were local.

The application supplies what is its own: its kinds, the name the store is reached by, and its rule for who may do what.

---

## What it is not

**Not the store.**\
It is never the source of an entity.\
Any view it keeps locally says how current it is, and the store remains the truth.

**Not the call layer.**\
It does not pair replies, time out calls, or carry parts.\
It uses the layer beneath that does.

**Not an authority.**\
It asks the application whether a caller may act; it never decides.\
The writer it records for a remote change is the one the application names from the caller's evidence, never one the client claims.

**Not the owner of kinds.**\
It carries whatever kinds the store holds, and knows none of them.

**Not a keeper of watchers.**\
It holds no record of who follows beyond the streams open now.\
When the call carrying a follow ends, for any reason, the follow closes; a caller ends a follow by ending its call.\
A watcher that leaves is forgotten, and resumes from its own position.

**Not a replicator.**\
It does not copy one store into another or merge several.\
One host serves one store, and a caller names the host it means, so another host claiming the same store cannot quietly answer in its place.

**Not a user interface.**\
It offers a client for application logic.\
Commands, screens, and wording belong to the application built on it.

---

## What success means

Four dimensions.\
They are not weighted, and they do not collapse.

**Fidelity.**\
A remote caller can rely on exactly what a local caller can.\
The measure is that the store's own guarantee checks, run through entityapi, give the same results as run against the store directly.

**Ease.**\
Application logic uses a remote store as it would a local one: the same operations, the same answers, and a few lines to start.\
The measure is the steps from nothing to a first remote call.

**Leanness.**\
It adds little code and little cost beyond the store and the call layer.\
A new kind adds no entityapi code at all.

**Reuse.**\
A second, unrelated application adopts both halves without a variant, a fork, or a change.

A programme strong on three of these and weak on one has one unmet dimension, and which one it is says more than any average of the four.

---

## Authority

Held by the director.\
Drafted by anyone; ratified only by the director.

This statement is amended, never quietly rewritten.\
A ruling that changes direction is recorded as a decision and absorbed here, so the reasoning survives the change.

Where this narrative and a verified record disagree about state, the record governs.
