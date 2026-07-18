# BNI 1-to-1 Conclave — Product Spec, Rulebook & Application Flow

> Status: v0.1 draft (derived from `initial-requirement-understanding.txt`).
> Decisions locked with stakeholder on 2026-06-27 are marked **[DECISION]**.
> Items still needing confirmation are in [§11 Open Questions](#11-open-questions).

---

## 1. The Idea (in one paragraph)

A BNI **conclave** is a large networking event where members do structured **1-to-1**
meetings. Members sit at tables; each table has a **captain** who anchors and facilitates
the table. The event runs in several **rounds**. Between rounds, members rotate to new
tables so that, over the event, each person meets as many *different* people as possible
while never sharing a table with someone in the *same business type*. This app lets an
**admin** register people, designate captains, snapshot who is present, auto-generate a
fair rotation schedule for all rounds, review/adjust it, lock it, and run the event
round-by-round. Members log in to see their own per-round table assignments.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Member** | A registered participant. Has a mandatory **business type**. |
| **Captain** | A member designated as a fixed table anchor. Stays at the same physical table for *all* rounds. Captains are a **disjoint pool** from rotating members during a conclave. |
| **Business type** | The member's profession/category (e.g. *software dev*, *caterer*). The core diversity dimension. |
| **Active user** | A user currently logged in. Auto-logout after `autoLogoutHours` (default 5, configurable) of login. |
| **Conclave** | A single event instance with its own config, snapshot, and schedule. |
| **Round** | One rotation. Every active member is seated at exactly one table. Captains do not move. |
| **Table** | A seat group of capacity `P` (1 captain + up to `P-1` members). |
| **Snapshot** | The frozen list of active users captured when the conclave **starts**. |
| **Schedule** | The full set of (round → table → occupants) assignments, precomputed at start. |
| **Lock** | The moment the schedule and roles become immutable and round 1 can begin. |

---

## 3. Roles & Capabilities

### 3.1 Admin
- CRUD members (name, business type **required**, unique identity).
- Designate / undesignate **captains**; switch a user captain ⇄ member **before lock**.
- Configure conclave: `personsPerTable (P)`, `roundCount (R)`, `autoLogoutHours`.
- Start the conclave (take the active snapshot).
- Trigger schedule generation; **review and manually override** any seat (with re-validation).
- **Lock** the conclave and run rounds (advance round, optional timer).
- After lock: **roles and schedule are frozen** (per the original rule).

### 3.2 Member (regular user)
- Log in (becomes *active*; auto-logout timer starts).
- View own schedule: for each round → table number, captain, and tablemates.
- (Optional) mark attendance / acknowledge.

> **[DECISION] Captain model = Fixed table anchor.** Captains never rotate. `#captains` must
> equal `#tables`. Members fill the remaining seats and rotate each round.

---

## 4. Configurable Parameters

| Param | Symbol | Default | Notes |
|---|---|---|---|
| Persons per table (incl. captain) | `P` | 7 | Must be `>= 2`. |
| Round count | `R` | — | Within `[minRounds, maxRounds]`. |
| Min rounds | — | 4 | |
| Max rounds | — | 8 | |
| Auto-logout | `autoLogoutHours` | 5 | Must be `> 0`. |
| Tables | `T` | *derived* | `T = ceil(A / P)` where `A` = active snapshot size. |

Captains required `= T`. **Admin must designate exactly `T` captains** before the schedule
can be generated.

---

## 5. The Matching Problem

This is the **Social Golfer / round-robin scheduling problem** with an added hard
coloring constraint.

### 5.1 Per-conclave setup (computed at start)
1. Snapshot active users → `A`. **[DECISION] Snapshot is taken once at start and frozen.**
2. `T = ceil(A / P)` tables.
3. Verify designated captains `== T`.
4. Members pool `M = A - T` (everyone not a captain), to be seated `R` times.

### 5.2 Constraints

| # | Constraint | Type | Rationale |
|---|---|---|---|
| C1 | No two people at the same table share a **business type** (captain included). | **HARD [DECISION]** | Table diversity is the point of BNI 1-to-1. |
| C2 | A given member-pair should not share a table more than once across rounds. | **SOFT [DECISION]** | Maximize unique meetings; relaxed only if forced. |
| C3 | Every active member is seated **exactly once per round**. | HARD | No clashes / no gaps. |
| C4 | Table occupancy `<= P`. | HARD | Physical capacity. |
| C5 | Captains stay at their assigned table every round. | HARD | Fixed-anchor model. |

### 5.3 Objective
**[DECISION] Maximize the number of distinct people each member meets** over all `R`
rounds (social-golfer coverage), subject to C1, C3–C5, while minimizing C2 violations
(repeat pairings, including repeat member↔captain meetings).

### 5.4 Worked re-validation of the original example
6 people, `R=3`, `T=3`, `P=2`. With the fixed-captain model, captains = T = 3. (The
original example pre-dates the fixed-captain decision and merely illustrates pairing;
under the new model two of the six would be captains. The *pairing* still demonstrates
C1 + C2: Ganesh & Samba are both *software dev* and are never seated together; and no
pair repeats across the three rounds. ✔)

---

## 6. Rulebook — Validation Gate (run before schedule generation)

Generation is **blocked** with an actionable message if any **hard** check fails.

### 6.1 Data-integrity validations
- **V1** Every member has a non-empty, recognized **business type**.
- **V2** Member identities are **unique** (no duplicate id / name collision policy).
- **V3** Captain pool and member pool are **disjoint** (no user flagged as both).

### 6.2 Configuration validations
- **V4** `P >= 2`.
- **V5** `minRounds <= R <= maxRounds` (default 4–8).
- **V6** `autoLogoutHours > 0`.

### 6.3 Capacity validations
- **V7** `A >= P` and `A > T` (at least one viable table, and members exist after captains).
- **V8** Designated captains `== T` where `T = ceil(A / P)`.
  - If captains `< T` → *"Designate N more captains."*
  - If captains `> T` → *"Remove N captains, or lower persons-per-table."*
- **V9** Capacity fit: `A <= T * P` (guaranteed by `T = ceil(A/P)`, asserted defensively).

### 6.4 Diversity-feasibility validations (the easy-to-miss ones)
- **V10 (distinct types vs table size)** `distinctBusinessTypes >= P`.
  *A table of size `P` needs `P` different types; otherwise C1 is unsatisfiable.* If it
  fails → suggest lowering `P` or merging/splitting business types.
- **V11 (per-type spread)** For **every** business type `b`:
  `count(active people of type b, captains included) <= T`.
  *In any single round each table holds at most one person of type `b`. If a type has more
  people than tables, they cannot all be seated in one round without a collision.* If it
  fails → suggest more tables (lower `P`) or flag the over-represented type.
- **V12 (captain type spread, advisory)** Warn if many captains share one business type —
  it shrinks the set of tables that members of that type can join (a type-`b` member cannot
  sit at a type-`b` captain's table), making V11 tighter in practice.

### 6.5 Soft / advisory warnings (don't block)
- **W1** Round count `R` exceeds the rounds needed to meet everyone
  (`R > ceil((A-1)/(P-1))`) → later rounds will force repeat pairings (C2).
- **W2** Uneven tables: `A` not divisible by `P` → some tables seat `P-1`. Show which.
- **W3** A business type is so dominant that repeat pairings are unavoidable.

---

## 7. Schedule Generation Algorithm

A deterministic, seeded heuristic with backtracking. Per round, solve a constrained
assignment; carry pairing history forward.

```
function generateSchedule(snapshot A, P, R, captains, seed):
    T = ceil(|A| / P)
    assert captains.count == T               # V8
    runValidationGate()                      # §6, hard checks must pass
    assignCaptainToTable(captain_i -> table_i)   # fixed for all rounds
    metPairs = {}                            # set of unordered pairs already tabled together
    schedule = []

    for r in 1..R:
        tables = [ {captain_i, type=captain_i.type, types={captain_i.type}} ... ]
        members = M sorted by (most-constrained-first:
                    fewest feasible tables, then highest repeat-risk)
        for m in members:
            candidates = tables where:
                  size < P
                  AND m.businessType NOT in table.types          # C1 hard
            rank candidates by:
                  1) fewest existing met-pairs with current occupants (minimize C2)
                  2) most empty seats (balance, W2)
                  3) deterministic tiebreak by seed
            if candidates empty:
                  backtrack / try alternative earlier placements
                  if still impossible -> record as INFEASIBLE_ROUND (see §7.1)
            place m in best candidate; update table.types, size
        for each table: add all new occupant pairs to metPairs
        schedule.append(tables)

    return schedule
```

### 7.1 Infeasibility handling (because C1 is hard, C2 is soft)
1. First, satisfy **C1** for every table (never break diversity).
2. To do so, the solver is **allowed to repeat a pairing** (break **C2**) — repeats are
   counted and surfaced in a per-round "repeat pairings: N" report.
3. If a round cannot satisfy **C1** even with repeats allowed, generation **fails for that
   round** and the admin is told the specific blocker (usually a V11 violation that slipped
   through due to manual overrides) and offered: lower `P`, adjust captains, or cap rounds.

### 7.2 Determinism
Same snapshot + same config + same `seed` ⇒ identical schedule (reproducible, auditable,
re-runnable). Store the `seed` with the conclave.

---

## 8. Application Flow

### 8.1 Admin happy path
```
1.  Admin signs in.
2.  Register/import members (business type required) ...... [V1, V2]
3.  Designate captain pool .................................. [V3]
4.  Configure P, R, autoLogoutHours ........................ [V4, V5, V6]
5.  Members log in -> become "active".
6.  Admin clicks START CONCLAVE -> snapshot active list (A) . [freeze]
7.  Compute T = ceil(A/P); prompt to fix captains to T ...... [V8]
8.  Run VALIDATION GATE .................................... [§6]
        - fail -> show actionable errors, return to step 2-4
        - pass -> continue
9.  GENERATE SCHEDULE (seeded) ............................. [§7]
10. Admin REVIEWS schedule; optional manual seat overrides
        -> each override re-runs validation on affected tables.
11. Admin LOCKS the conclave .............................. [roles+schedule frozen]
12. Run rounds: show Round 1..R seating; advance/stop;
        optional per-round timer + repeat-pairings report.
```

### 8.2 Member happy path
```
1. Member logs in (active; auto-logout timer starts).
2. After lock: views own schedule -> per round: table #, captain, tablemates.
3. (Optional) marks attendance per round.
```

### 8.3 State machine (conclave)
```
DRAFT --(start)--> SNAPSHOTTED --(validate ok)--> SCHEDULED
SCHEDULED --(admin edits)--> SCHEDULED   (re-validate)
SCHEDULED --(lock)--> LOCKED --(begin)--> RUNNING --(finish)--> COMPLETED
Any --(admin cancel before lock)--> DRAFT
```
Roles/schedule mutable only in `DRAFT`/`SNAPSHOTTED`/`SCHEDULED`. Frozen from `LOCKED`.

---

## 9. Data Model (entity sketch, stack-agnostic)

```
User        : id, name, businessType, contact, isAdmin
Conclave    : id, name, status, P, R, autoLogoutHours, seed,
              createdAt, snapshotAt, lockedAt
LoginSession: id, userId, loginAt, expiresAt(=loginAt+autoLogoutHours), isActive
Snapshot    : conclaveId, userId            (the frozen active list)
CaptainAssignment : conclaveId, userId, tableNumber   (fixed anchor)
Seat        : conclaveId, roundNumber, tableNumber, userId, isCaptain
MetPair     : conclaveId, userIdA, userIdB, firstRound  (for C2 / reporting)
```
Indexes: `Seat (conclaveId, roundNumber, tableNumber)`, unique `Seat (conclaveId, roundNumber, userId)` to enforce **C3**.

---

## 10. Suggested Missing Validations & Edge Cases (beyond the original notes)

These were **not** in the original requirements and are worth confirming:

1. **V10 / V11 diversity feasibility** — the original rules assumed C1 is always
   satisfiable. It is not, unless `distinctTypes >= P` and `count(type) <= T`. **High
   priority** — without these the generator can hard-fail mid-run.
2. **Uneven division** of `A` by `P` (remainder seats). Define explicitly: tables hold
   `P` or `P-1`; never overflow.
3. **Captain count vs table count** mismatch handling (V8) with clear remediation text.
4. **Captain business-type clustering** (V12) — degrades feasibility quietly.
5. **Auto-logout vs snapshot** — confirm that a member who auto-logs-out *after* snapshot
   still keeps their seat (decision: yes, schedule is frozen; show "expected absent").
6. **No-show handling at runtime** — a snapshotted member who never shows. Allow admin to
   mark absent; their seat is simply empty (does not re-trigger generation post-lock).
7. **Manual override re-validation** — any admin seat edit must re-check C1/C4 on touched
   tables and update the repeat-pairings count.
8. **Reproducibility / audit** — persist `seed` + snapshot so a schedule can be regenerated
   and disputes resolved.
9. **Determinism of "active"** — define the exact instant `active` is read (start click),
   and timezone/clock source for auto-logout.
10. **Minimum viable conclave** — guard tiny inputs (`A < P`, `T < 2`, `R < minRounds`).
11. **Duplicate-identity policy** (V2) — same name, different person; need a stable id.
12. **Business-type taxonomy** — free text vs controlled list. A controlled list makes
    C1/V10/V11 reliable; free text risks "Software Dev" ≠ "software developer" mismatches.

---

## 11. Open Questions

1. **Business-type taxonomy:** controlled dropdown (recommended) or free text? Affects
   reliability of every diversity rule.
2. **Member↔captain repeats:** is meeting the *same captain* twice as undesirable as
   meeting the same member twice (both count toward C2), or do captain re-meets matter less?
3. **Round timing:** does the app run a per-round countdown timer, or is timing offline and
   the app only displays seating?
4. **Attendance/no-show:** should the app track who actually attended each round, and should
   that feed any post-event report?
5. **Multiple concurrent conclaves:** one event at a time, or several in parallel (affects
   data model scoping — already scoped by `conclaveId` above as a hedge).
6. **Tech stack & deployment target** (web/mobile, expected concurrency at ~250 users) — not
   yet specified; needed for Phase planning below.

---

## 12. Proposed Development Plan (phased)

> Sequenced so the riskiest part — the matching engine — is proven early and in isolation.

**Phase 0 — Foundations**
- Repo/init, chosen stack, auth (admin + member), data model from §9.

**Phase 1 — Member & Captain management**
- Member CRUD with required business type (V1/V2), controlled type list.
- Captain designation, captain⇄member switching, disjointness (V3).

**Phase 2 — Matching engine (standalone, unit-tested first)**
- Implement §7 algorithm + §6 validation gate as a pure module with fixtures
  (incl. the 6-person example and infeasible cases for V10/V11).
- Deterministic seed; repeat-pairings report. **Build this before any UI.**

**Phase 3 — Conclave lifecycle**
- Config (P, R, autoLogout), login/active tracking, auto-logout timer.
- Start → snapshot → validate → generate → review/override → lock state machine (§8.3).

**Phase 4 — Run & view**
- Admin round-runner (advance rounds, optional timer, repeat report).
- Member schedule view (per-round table/captain/tablemates).

**Phase 5 — Hardening & reporting**
- No-show handling, audit/seed persistence, edge-case guards (§10), post-event summary.

---

*Source of truth for original intent: `initial-requirement-understanding.txt`.*
```
