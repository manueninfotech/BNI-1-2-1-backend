# Conclave API

Everything an admin-panel or mobile client needs. If something here is unclear or
missing, say so and we'll add it — this is the contract.

**Base URL:** `https://<deployment>/api` (local: `http://localhost:3000/api`)

---

## 1. Authentication

Every endpoint except `GET /health` requires a **Firebase ID token**:

```
Authorization: Bearer <firebase-id-token>
```

Get one from the Firebase JS SDK after signing in:

```js
const token = await firebase.auth().currentUser.getIdToken();
```

There are two levels:

| Level | How it's checked | Used by |
|---|---|---|
| **Member** | Valid Firebase token. | `/api/conclaves/*` |
| **Admin** | Valid token **AND** an `admins/{uid}` document exists. | `/api/admin/*` |

> Being signed in is **not** enough to be an admin. The `admins/{uid}` document
> *is* the grant, and it is created by hand:
>
> ```bash
> npm run create-admin -- you@example.com "a-strong-password"
> ```
>
> Revoke by deleting that document (takes effect within 60s — the allowlist is
> cached).

**The caller's uid always comes from the verified token, never from the request
body.** Do not send a `userId` field expecting it to be honoured; it will be
ignored, and for `/sync` it will get your records rejected.

---

## 2. Errors

Uniform shape:

```json
{ "error": "Human-readable explanation." }
```

Some errors carry extra fields (documented per endpoint). Statuses:

| Code | Meaning |
|---|---|
| `400` | Bad input, or a domain rule says no (e.g. not enough captains). |
| `401` | Missing / invalid / expired token. |
| `403` | Signed in, but not an administrator. |
| `404` | Conclave or user not found. |
| `409` | State conflict (already running, roles frozen, clashing registration). |
| `429` | Rate limited. |
| `500` | Unexpected. |

Error messages are written to be shown to a human. Prefer displaying `error`
directly over inventing your own text.

---

## 3. Conclave lifecycle

```
registrationNotOpen  ← created here, doors shut
        │  POST /registration {open:true}
        ▼
 registrationOpen     ← members can register
        │  POST /registration {open:false}
        ▼
registrationClosed
        │  POST /generate-schedule     (needs exactly one captain per table)
        │  POST /start-round {1}
        ▼
     running          ← rounds advance one at a time
        │  POST /complete
        ▼
    completed         ← members can now see their summaries

  (cancel → cancelled, from any non-completed state)
```

Two rules worth knowing before you build the UI:

- **Roles freeze** once a conclave is `running`. Assign captains before starting.
- **The system will not invent captains.** Generation fails unless the admin has
  designated exactly one per table — see `POST /generate-schedule`.

---

## 4. Admin endpoints

All require an **admin** token. Prefix: `/api/admin`.

### `GET /conclaves`
All conclaves, newest first, each with `registrationCount`.

### `POST /conclaves`
Create. Registration starts **closed**.

```json
{
  "name": "Guntur Mega Conclave",
  "venueLocation": "ITC Grand",
  "date": "2026-01-01",
  "startTime": "2026-01-01T09:00",   // optional
  "endTime":   "2026-01-01T11:00",   // optional
  "chiefGuests": ["Dr. Ramesh Kumar"], // optional
  "personsPerTable": 7,
  "roundCount": 6
}
```

`personsPerTable` ≥ 2. `roundCount` must be **4–8** (the engine's limits) — this
is rejected at creation now, not later at generation.

→ `201 { "conclaveId": "..." }`

> **Set `startTime` and `endTime`.** They're optional, but without them a conclave
> is treated as occupying its whole day for clash detection, which blocks members
> from registering for anything else that day. See §5.

### `PATCH /conclaves/:id`
Edit. Any subset of the create fields.

- `409` if the conclave is `running` or `completed`.
- `409` if you try to change `personsPerTable` / `roundCount` **after** a schedule
  exists — that would leave the schedule describing a different event. Regenerate
  instead.

### `POST /conclaves/:id/registration`
```json
{ "open": true }
```
Two-way. `409` once running/completed/cancelled.

### `POST /conclaves/:id/cancel`
Terminal. `409` if already completed.

### `POST /conclaves/:id/complete`
Ends the conclave. **This is what unlocks the members' post-conclave summaries** —
until then nobody can see what they recorded or whether it synced.

- `409` unless the conclave is `running`.
- → `{ "endedEarly": true, "finalRound": 4, "roundCount": 6 }` if ended early.

### `POST /conclaves/:id/start-round`
```json
{ "roundNumber": 1 }
```
- `400` if round 1 and no schedule exists.
- `409` if **you** are already running another conclave. Rounds are advanced by
  hand by someone in the room; they cannot be in two rooms. A *different* admin
  running a different conclave is fine.
  → `{ "error": "...", "runningConclaveId": "..." }`

Sends an FCM push to the conclave topic. Treat that as a nudge — the app derives
round state from the conclave document, not from the notification.

### `POST /conclaves/:id/generate-schedule`
```json
{ "activeOnly": true, "autoFillCaptains": false }
```

- **`activeOnly`** — seat only *active* users (logged in within
  `autoLogoutHours`), i.e. the people actually in the room. This is the spec's
  "250 registered, 200 active" case. The snapshot is **frozen** at this moment.
- **`autoFillCaptains`** — default `false`. The system does **not** know who
  should anchor a table, so it refuses to guess.

If the captain count is wrong you get a `400` you can act on directly:

```json
{
  "error": "This conclave needs exactly 36 captains (one per table) but 30 are designated. Designate 6 more captain(s).",
  "captainsRequired": 36,
  "captainsDesignated": 30,
  "hint": "Re-send with autoFillCaptains: true to let the system choose the remainder."
}
```

Other `400`s worth handling:

- **Validation failed** — carries `issues[]` (codes V1–V12) and `warnings[]`. The
  useful ones: `V10` (a table of P needs P distinct business categories) and
  `V11` (a category has more people than there are tables, so they can't all be
  seated in one round).
- **No category-safe seating exists** — the roster passed validation but the
  matcher couldn't seat it. Almost always because participants divide *exactly*
  by table size, leaving zero spare seats. Nudge `personsPerTable`.

Success:

```json
{
  "tableCount": 36, "captains": 36, "participants": 250,
  "activeOnly": true, "skippedInactiveCount": 50,
  "warnings": [{ "code": "W2", "message": "..." }],
  "stats": { "coverage": 0.82, "repeatPairings": 26, ... }
}
```

### `GET /conclaves/:id/registrations`
Everyone registered, with the detail needed to choose captains.

```json
{
  "status": "registrationOpen",
  "rolesLocked": false,
  "personsPerTable": 7,
  "autoLogoutHours": 5,
  "registrations": [
    { "uid": "...", "role": "member", "name": "Eb", "phone": "+91...",
      "businessName": "Eb Tech", "businessCategory": "Computer Services",
      "location": "guntur", "isActive": true, "lastLoginAt": "..." }
  ],
  "counts": {
    "total": 250, "active": 200,
    "captainsDesignated": 30,
    "captainsRequired": 36,
    "captainsRequiredIfActiveOnly": 29,
    "members": 220
  }
}
```

`captainsRequired` = `ceil(total / personsPerTable)`. If you intend to generate
with `activeOnly`, the number to hit is `captainsRequiredIfActiveOnly`.

### `POST /conclaves/:id/registrations/:uid/role`
```json
{ "role": "captain" }
```
`409` once the conclave is running/completed/cancelled — roles are frozen.

### `GET /users/search?q=...`

Find a member by email or phone. Admin-only — as a public endpoint this would be
a membership-enumeration oracle.

```json
{ "results": [ { "uid": "...", "name": "Eb", "email": "...", "phone": "+91...",
                 "businessName": "Eb Tech", "businessCategory": "Computer Services" } ] }
```

### `POST /users/:uid/reset-link`

Generates a **one-time password reset link** and returns it to you.

This exists because Firebase has no phone+password sign-in: a phone registration
is keyed by a synthetic address (`919515409973@bni121.conclave`) that no mailbox
receives, so the self-serve "email me a link" flow has nowhere to send and those
members are simply stuck.

```json
{
  "message": "Send this link to the member. It can only be used once.",
  "link": "https://conclave-1-2-1.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=...",
  "name": "Eb",
  "email": "eb@example.com",
  "phone": "+919515409973",
  "isPhoneAccount": true,
  "expiresInHours": 1
}
```

Send the link to the member over WhatsApp or SMS — `email`/`phone` tell you
where. **The member sets their own password, so you never learn it**; that is why
this is a link rather than a temporary password you read out.

The link **expires in an hour** and works **once**. `email` and `phone` may be
empty for accounts created before both contacts were collected.

> If you later wire up a mail service, this is the seam: send `link` to `email`
> server-side and stop returning it.

### `GET /conclaves/:id/stats`
The live dashboard. Poll it.

```json
{
  "serverReceivedAt": "...", "serverSentAt": "...",
  "status": "running", "currentRound": 3, "roundCount": 6,
  "autoLogoutHours": 5,
  "startsAt": "...",
  "currentRoundStartedAt": "...",
  "currentRoundEndsAt": "...",
  "currentRoundComplete": false,
  "roundActiveMs": 630000, "roundTransitionMs": 270000,
  "counts": { "registered": 250, "active": 200, "captains": 36,
              "members": 214, "referrals": 412, "attendanceRecords": 1180 }
}
```

**Round timing** is derived, not configured: a round occupies a fixed **15-minute
block**, of which **1.5 min per person** at the table is talking time and the rest
is transition. P=8 → 12 + 3. P=6 → 9 + 6.

**Use `serverReceivedAt` / `serverSentAt` to correct your clock** — see §6. If you
compute the countdown against your own `Date.now()`, your timer will disagree with
the phones'.

---

## 5. Member endpoints

Require a **member** token. Prefix: `/api/conclaves`.

### `POST /conclaves/:id/register`

Registers **the caller** (from the token).

- `409` if registration isn't open.
- `409` if it **clashes** with another conclave they're registered for:

```json
{
  "error": "This clashes with \"Morning Conclave\", which you are already registered for. ...",
  "conflictsWith": {
    "conclaveId": "...", "name": "Morning Conclave",
    "venueLocation": "Venue X",
    "start": "2026-01-01T09:00:00.000Z", "end": "2026-01-01T11:00:00.000Z"
  }
}
```

The rule: **a member may not hold two registrations whose times overlap.** Same day
at a different hour is fine. A different day is fine. Back-to-back (one ends as the
other starts) is fine. If a conclave has no start/end time, it is treated as
occupying its whole day — so *set the times*.

**There is no withdraw endpoint, deliberately.** Once the schedule seats and pairs
someone, letting them vanish leaves a hole in other people's tables.

Repeating the call is idempotent → `{ "alreadyRegistered": true }`.

### `POST /conclaves/:id/sync`

The offline-first endpoint. The app captures attendance and referrals locally and
pushes them here.

```json
{
  "attendance": [
    { "id": "c1-2-uidX", "userId": "uidX", "roundNumber": 2,
      "tableNumber": 4, "isPresent": 1, "markedBy": "uidCaptain",
      "timestamp": "2026-07-14T10:05:00Z" }
  ],
  "referrals": [
    { "id": "...", "roundNumber": 2, "fromUserId": "uidMe",
      "toUserId": "uidThem", "notes": "...", "timestamp": "..." }
  ]
}
```

**The server validates every row against the schedule.** A row is rejected if:

- it isn't attributed to *you* (`markedBy` / `fromUserId` ≠ your uid);
- you're marking attendance for someone who is neither yourself nor a member of
  the table **you captain that round**;
- you're referring someone you did **not** share a table with that round.

Rejected rows still come back in `syncedAttendanceIds` (so the phone stops
retrying a poisoned record forever) with the reason in `errors[]`.

Response:

```json
{
  "serverReceivedAt": "...", "serverSentAt": "...",
  "syncedAttendanceIds": ["..."],
  "syncedReferralIds": ["..."],
  "newReferralsReceived": [
    { "id": "...", "roundNumber": 1, "fromUserId": "...",
      "fromName": "Anita Reddy", "fromBusinessName": "Anita Legal",
      "notes": "...", "createdAt": "..." }
  ],
  "conclaveStatus": { "status": "running", "currentRound": 3,
                      "currentRoundStartedAt": "..." },
  "errors": []
}
```

> **Critical contract:** the client marks a record synced the moment its id appears
> in `syncedAttendanceIds` / `syncedReferralIds`, and never retries it. The server
> therefore **commits to Firestore first** and only then acknowledges. If the write
> fails you get a `500` with **no** acknowledged ids, and the phone keeps its data.
> Do not "optimise" this by acknowledging early.

**Attendance precedence:** a member and their captain can both mark the same person.
Both marks are stored; the truth is `isPresent = captainMark ?? selfMark`. **The
captain is believed**; the self-mark is the fallback used when the captain never
recorded that person (dead phone, missed badge).

**Referrals are one fact seen from two sides.** A referral created on A's phone
appears in A's *given* list and, automatically, in B's *received* list. B never
confirms anything. Because it was created on A's device, it can only reach B by
coming back down through `newReferralsReceived` — which is why sync runs even when
the client has nothing to push.

---

## 6. Clock synchronisation (please read)

Round boundaries are set by the **server**. If you evaluate them against your own
clock, your countdown will drift from everyone else's — and worse, any gating you
do (accepting attendance only while the round is open) will fire at the wrong time.

`/sync` and `/stats` both return an NTP-style pair:

```
offset = ((t1 - t0) + (t2 - t3)) / 2

  t0 = you sent the request
  t1 = serverReceivedAt
  t2 = serverSentAt
  t3 = you received the response
```

Then use `Date.now() + offset` everywhere instead of `Date.now()`.

**Do not** just take one server timestamp and assume it was sampled at the midpoint
of the round trip. These endpoints do real Firestore work — often **seconds** of it —
and that naive estimate mistakes the processing time for network latency, pushing
your clock seconds into the future. The `(t2 - t3)` term is what cancels it out.

---

## 7. Rate limits

| Endpoint | Limit |
|---|---|
| `/sync` | 30 / minute per user |
| everything else | 120 / minute per user |

Keyed by **uid**, not IP — at the venue every phone is behind one NAT, and keying
by IP would make your own network look like an attacker.

---

## 8. Firestore access from clients

Clients read the `conclaves` collection directly (that's what makes the app work
offline — the schedule is served from Firestore's local cache). But under the
security rules:

- `conclaves`, `registrations`, `settings` → **read-only**
- `users/{uid}` → read/write **your own** only
- `attendance`, `referrals`, `admins` → **no client access at all**

Anything that isn't a plain read goes through this API.
