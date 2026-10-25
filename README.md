# Conclave Backend

The API and matching engine for **BNI 121 Conclave**.

- **[docs/API.md](docs/API.md)** — the full API reference. Start here if you're integrating.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how it's laid out and why.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — shipping to Azure.
- **[docs/SPEC.md](docs/SPEC.md)** — the product spec and matching rulebook.

**Stack:** Node + Express (TypeScript, run with `tsx`), **PostgreSQL** via Drizzle
ORM, **Azure Blob Storage** for files, **Firebase Auth** for sign-in and **FCM**
for push. Firebase is used for nothing else.

---

## Quick start

```bash
brew install postgresql@17 && brew services start postgresql@17
createdb conclave_dev && createdb conclave_test

npm install
cp .env.example .env          # set FIREBASE_SERVICE_ACCOUNT (and DATABASE_URL if not the default)
npm run db:migrate            # create / update the schema
npm run seed                  # optional: a demo conclave with 30 members (local DB only)
npm run dev                   # http://localhost:3000 — also migrates on boot
npm test                      # 170+ tests against conclave_test
```

Create an admin (this is the grant — signing in is not enough):

```bash
npm run create-admin -- you@example.com "a-strong-password" superadmin   # or admin | coordinator
```

---

## Layout

```
src/
  config/        env + Firebase (Auth, FCM), resolved once
  db/            Drizzle schema, Postgres pool, boot-time migrations
  audit/         the audit trail: writers, diff/redaction, admin query
  observability/ per-request context (request id, actor, source)
  middleware/    request context, auth, region guard, errors, rate limiting
  routes/        URL -> controller
  controllers/   HTTP in, HTTP out. No logic.
  services/      the actual work. No Express types.
  domain/        pure rules: captains, clashes, timing, seating
  engine/        the matching engine (social-golfer + category colouring)
drizzle/         SQL migrations (generated, reviewed, committed)
scripts/         create-admin, seedDev, importFromFirestore
```

The rule: **controllers know about HTTP, services know about the domain, and
domain knows about nothing.** Anything in `domain/` and `engine/` is pure and
unit-tested; services are tested against a real Postgres (`conclave_test`).

---

## Database & migrations

- Schema lives in `src/db/schema.ts`. To change it: edit the schema, run
  `npm run db:generate -- --name <what-changed>`, review the SQL in `drizzle/`,
  commit both.
- The server applies pending migrations **on boot, before accepting traffic**,
  under an advisory lock (safe with several instances). `npm run db:migrate`
  does the same by hand.
- Ids are text, timestamps `timestamptz`. Fields that came from Firestore with no
  column are kept in each row's `legacy` jsonb — never write new data there.

## Audit trail

Every state-changing API call and every refused one is recorded in `audit_log`
(append-only — a trigger blocks UPDATE/DELETE/TRUNCATE):

- **`request` rows** — automatic, for every POST/PUT/PATCH/DELETE and every
  401/403: who, role, client (`X-Client` header or detected), IP, route, status,
  redacted body, duration.
- **`change` rows** — written by services inside the same transaction as the
  change, with a field-level `before → after` diff. If the audit write fails,
  the change rolls back.
- **`system` rows** — scheduled jobs and scripts.

All rows share the request's `requestId`, which is also returned in the
`X-Request-Id` header and in every error body. Secrets, tokens, signatures and
file contents are never stored. Admins read it via `GET /api/admin/audit`.

When adding a service method that changes data, call
`audit.change({ action, entityType, entityId, before, after }, tx)` inside the
transaction.

## Files

Uploads go to a **private** Azure Blob container. Records store a link to our
API (`/api/files/<path>`), which redirects to a 10-minute signed URL. No
permanent public file URL exists; deleting the blob revokes every link.

---

## Security

- **The caller's uid always comes from the verified Firebase token**, never the
  request body. An unverifiable token is a 401 — nothing else is accepted.
- **Admin = verified token AND a row in `admins`** (status Active). Matching by
  email only for a Firebase-verified email. Lookup failure → 503, never access.
- **Who manages whom:** superadmin → anyone; admin → coordinators; coordinator →
  nobody. Nobody deletes or demotes themselves.
- **Regional scope:** every `/api/admin/conclaves/:id/...` route checks the
  conclave is in the caller's region (superadmins and Global admins see all).
- **`/sync` validates every row against the schedule**: marks you made, yourself
  or your own table that round; referrals only to people you shared a table with.
- **Payments:** a Razorpay payment must belong to this member and this conclave,
  and can pay for one registration only.
- The server refuses to start with `ALLOW_INSECURE_ADMIN=true` in production.

---

## Deploying

Azure Container Apps — see **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. CI
(GitHub Actions) runs the typecheck and the full test suite against Postgres on
every push.
