# Decisions

One ruling per entry, append-only.\
A ruling is never edited; a later one supersedes it and says so.

Rulings that shape this component together with others are held in zorg's `docs/DECISIONS.md`, and cited here as "zorg's `Dn`".

---

## D1 - The component stands in its own repository

**Ruled by:** the director, 2026-10-09 (zorg's `D16`).\
**Affects:** this repository.

**Ruling.**\
This component was split out of zorg with the history of its vision and contract, and is private until its first working code.\
Its vision was ratified by zorg's `D5`, and its contract of record is `CONTRACT.md` (zorg's `D17`).

**Why.**\
Each component holds its own boundary and its own history from the start, as zorg's `D10` intends.

---

## D2 - Renamed entity-api

**Ruled by:** the director, 2026-10-09 (zorg's `D18`).\
**Affects:** this repository, its package, `VISION.md`, `CONTRACT.md` and `README.md`.

**Ruling.**\
The component formerly named entityapi is named entity-api, in hyphenated whole words like every other name in the workspace; its repository is `apnex/entity-api`, and GitHub redirects the old name.\
Earlier entries keep the name they were written with.
