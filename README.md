# Conclave Backend

The API and matching engine for **BNI 121 Conclave**.

- **[docs/API.md](docs/API.md)** — the full API reference. Start here if you're
  integrating.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how it's laid out and why.
- **[docs/SPEC.md](docs/SPEC.md)** — the product spec and matching rulebook.

---

## Quick start

```bash
npm install
cp .env.example .env        # then set FIREBASE_SERVICE_ACCOUNT
npm run dev                 # http://localhost:3000
npm test
```

Create an admin (this is the grant — signing in is not enough):

```bash
npm run create-admin -- you@example.com "a-strong-password"
```

---

## Layout

```
src/
  config/        env + firebase, resolved once
  middleware/    auth, errors, rate limiting
  routes/        URL -> controller
  controllers/   HTTP in, HTTP out. No logic.
  services/      the actual work. No Express types.
  domain/        pure rules: captains, clashes, timing, seating
  engine/        the matching engine (social-golfer + category colouring)
  utils/         Firestore batching, date coercion
api/index.ts     Vercel serverless entrypoint
scripts/         create-admin
```

The rule: **controllers know about HTTP, services know about the domain, and
domain knows about nothing.** Anything in `domain/` is pure and unit-tested
without Firestore or Express — which is why the interesting rules live there.

---

## What the engine does

A conclave seats people at tables over several rounds so that everyone meets as
many *different* people as possible, while **never** sharing a table with someone
in the same business category.

- **C1 (hard):** no two people of the same business category at a table. Never
  violated.
- **C2 (soft):** a pair should not share a table twice. Minimised; broken only if
  forced.
- **C3–C5 (hard):** everyone seated exactly once per round; tables never exceed
  capacity; captains stay anchored to their table all event.

`validate()` runs **before** generation and catches the traps that are otherwise
only discovered at the venue — e.g. a table of 7 needs 7 distinct categories
(V10), and a category with more people than there are tables can't be seated in a
single round (V11).

**Known limitation:** when the participant count is an *exact* multiple of
persons-per-table there is zero spare capacity, and the greedy matcher can fail
even though validation passes. Surfaced as an actionable `400`. Nudging
persons-per-table resolves it.

---

## Security

The things worth knowing:

- **The caller's uid always comes from the verified Firebase token, never from
  the request body.** A uid in the body is just a string the caller typed.
- **Admin = valid token AND an `admins/{uid}` document.** The document is the
  grant, written by hand.
- **`/sync` validates every row against the schedule**: you can only submit marks
  you made, only mark yourself or someone at the table you captain *that round*,
  and only refer someone you actually shared a table with.
- **Firestore rules deny clients everything except reading conclaves and
  reading/writing their own profile.** See `firestore.rules`.

Deploy the rules:

```bash
firebase deploy --only firestore:rules
```

---

## Deploying

Vercel, as a serverless function (`api/index.ts`). There is no long-lived process,
so `npm run dev` is a local convenience, not the production shape.

Set in the Vercel dashboard:

| Variable | Notes |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | The service account JSON, raw or base64. **Required.** |
| `CORS_ORIGINS` | The admin panel's origin. |
| `NODE_ENV` | `production` |

Leave `ALLOW_INSECURE_ADMIN` and `ENABLE_DEV_ROUTES` unset.

Put the function in the region closest to your Firestore database — nearly all the
latency here is Firestore round trips.
