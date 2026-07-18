# Architecture

Why the code is shaped the way it is. Read this before changing anything
structural.

---

## The layers

```
  HTTP
   │
routes/         URL -> handler. Auth is applied here, once, per router.
   │
controllers/    Parse the request, call a service, shape the response.
   │            No business logic. No Firestore.
   │
services/       The actual work. Talks to Firestore. Throws ApiError.
   │            Knows nothing about Express (no req/res).
   │
domain/         Pure rules. No I/O at all. Fully unit-tested.
engine/         The matching engine. Pure. Untouched since it was written.
```

**The rule:** controllers know about HTTP, services know about the domain, and
domain knows about nothing.

The payoff is `domain/`: every rule that is easy to get wrong lives there, and can
be tested without booting a server or touching a database.

| File | The rule it owns |
|---|---|
| `domain/scheduleIndex.ts` | Who may mark whom present. Who may refer whom. |
| `domain/schedulingRules.ts` | When two conclaves clash. |
| `domain/captains.ts` | Resolving captains to exactly one per table, spread across categories. |
| `domain/conclave.ts` | Lifecycle states, round timing, engine limits. |

---

## Why auth is mounted on the router, not per-endpoint

```ts
router.use(requireAdmin);   // admin.routes.ts
router.use(requireUser);    // member.routes.ts
```

A new admin endpoint added tomorrow is protected automatically. The previous
backend applied auth per-endpoint, and `/sync` — the one endpoint every phone
calls — was simply missed. It was completely unauthenticated, and took the user's
identity from the request body, so anyone who knew a conclave id could rewrite
any member's attendance and read their referrals.

Guard the surface, not the door.

---

## Why the uid never comes from the body

`req.uid` is set only by auth middleware, from a **verified** Firebase token. A
`userId` field in a request body is just a string the caller typed. Services take
the caller's uid as an explicit argument so it cannot be confused with untrusted
input:

```ts
export async function syncConclave(conclaveId, callerUid, input, ...)
                                                ^^^^^^^^^  ^^^^^ untrusted
```

---

## Why `/sync` validates against the schedule

The phone is not trustworthy — it's a client. The QR scanner enforces "is this
person at your table?" on the device, which is good UX and worth nothing as a
security control.

So the server rebuilds the seating from the stored schedule (`ScheduleIndex`) and
checks each row:

- Is this record attributed to the caller?
- Is the caller the subject, or the **captain of the subject's table that round**?
- For referrals: did these two actually share a table that round?

Rejected rows are **acknowledged anyway**, with a reason in `errors[]`. Otherwise
a poisoned record would sit on a phone retrying forever.

---

## Why sync commits before it acknowledges

The client marks a record synced the instant its id comes back, and never retries
it. So:

```
commit to Firestore  →  then acknowledge the ids
```

Never the other way round. The original implementation echoed the ids back
*without writing anything*; the phones dutifully marked everything synced, and an
entire event's attendance and referrals were destroyed. This ordering is the whole
reason the offline design works, and it must not be "optimised".

---

## Why attendance stores two marks

A member and their captain can both mark the same person, on different devices,
syncing in an arbitrary order. A single `isPresent` field meant **whoever synced
last won** — the answer depended on network timing.

```
isPresent = captainMark ?? selfMark
```

The captain is believed. The self-mark is the fallback, used when the captain
never recorded that person — a dead captain phone, a missed badge. Both are kept,
so the source is always recoverable.

---

## Why the clock is synchronised NTP-style

Round boundaries are set by the server, but were being evaluated against each
device's clock. Drift didn't just skew the countdown — it skewed the **gate**, so a
phone running slow would keep accepting attendance after the round had closed.

The naive fix (one server timestamp, assume it came from the midpoint of the round
trip) is *worse than nothing here*, because these endpoints do seconds of Firestore
work: half the processing time gets added to the client's clock. Hence the
four-timestamp exchange, where the `(t2 - t3)` term cancels processing time out
exactly.

---

## Why Firestore reads are batched

`for (const uid of uids) await get(uid)` is one network round trip per person. At
300 participants, on an endpoint the dashboard polls every 10 seconds, that alone
exceeded a serverless timeout. `getAllDocs()` batches into a single RPC.

Latency here is almost entirely Firestore round trips, not compute. When something
is slow, count the round trips first.

---

## What is deliberately NOT here

- **No ORM / repository abstraction over Firestore.** Services use the Firestore
  SDK directly. One database, no plans for another; an abstraction would be a
  layer to maintain with nothing behind it.
- **No dependency-injection container.** Modules import what they need. The
  pure-domain split is what makes testing easy, not DI.
- **No caching layer beyond two 60-second in-memory caches** (admin allowlist,
  settings). They exist because those two reads happen on almost every request and
  change almost never. Everything else is read fresh — a live event cannot serve
  stale round state.
