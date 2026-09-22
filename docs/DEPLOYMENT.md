# Deploying the Conclave stack

A practical runbook for shipping each piece of BNI 121 Conclave to production.
Written for a human to follow by hand today; the backend steps will be wrapped
in a script later (see [Automate this next](#automate-this-next)).

> **Heads-up on the word "Azure".** Only the **backend** runs on Azure. The
> **admin panel** is a static site on **Vercel**, and the **mobile apps** ship to
> the **Google Play Store** and **Apple App Store**. Each section below says
> exactly where its piece goes.

| Piece | Repo | Hosted on | Deploy with |
|-------|------|-----------|-------------|
| Backend API | `manueninfotech/BNI-1-2-1-backend` | Azure Container Apps | `az acr build` + `az containerapp update` |
| Admin panel | *(the Vite admin repo)* | Vercel | `vercel --prod` (or push the production branch) |
| Mobile apps | `manueninfotech/bni_121_conclave_frontend` | Play + App Store | `scripts/release.sh` / fastlane |

---

## 0. One-time prerequisites

```bash
# Azure CLI (backend)
az login                       # sign in to the MANUEN subscription
az account show --query name   # must say "MANUEN - Azure subscription"
az extension add --name containerapp --upgrade   # first time only

# Node (backend typecheck + admin build)
node -v                        # v20+

# Vercel CLI (admin)   — npm i -g vercel ; vercel login
# Flutter + fastlane (apps) — see the frontend repo's scripts/RELEASE.md
```

**Azure resources (already provisioned — do not recreate):**

| Thing | Name |
|-------|------|
| Resource group | `rg-conclave-prod` |
| Container registry (ACR) | `conclaveacr336510` (`conclaveacr336510.azurecr.io`) |
| Container Apps environment | `conclave-env` |
| Container app | `conclave-backend` |
| Public URL | `https://conclave-backend.blackpond-26884e90.centralindia.azurecontainerapps.io` |
| Region | Central India |

---

## 1. Backend → Azure Container Apps

The image has **no compile step** — it runs the TypeScript entrypoint directly
with `tsx` (see `Dockerfile`). So "build" just means baking the current source
into a container image in ACR, then pointing the app at it.

```bash
cd ~/Documents/web/bni-1-2-1-backend

# 1. Get the code you intend to ship and sanity-check it.
git checkout main && git pull
npx tsc --noEmit                     # must be clean (type errors = stop)

# 2. Build the image inside ACR (uses the Dockerfile in this repo).
az acr build --registry conclaveacr336510 --image conclave-backend:latest .

# 3. Roll it out. Pin the DIGEST, not the :latest tag — see the note below.
DIGEST=$(az acr repository show -n conclaveacr336510 \
  --image conclave-backend:latest --query digest -o tsv)

az containerapp update -n conclave-backend -g rg-conclave-prod \
  --image "conclaveacr336510.azurecr.io/conclave-backend@$DIGEST"

# 4. Verify.
curl -s https://conclave-backend.blackpond-26884e90.centralindia.azurecontainerapps.io/health
# -> {"status":"ok","timestamp":"..."}
```

> **Why pin the digest?** The app tag is `:latest`. If you redeploy with the same
> `:latest` string, Container Apps sees no change and won't pull the rebuilt
> image. Deploying by `@sha256:…` digest forces a brand-new revision running the
> exact image you just built.

The app runs in **single-revision mode**: `containerapp update` creates a new
revision, sends 100% of traffic to it, and retires the old one automatically.
(The old revision can linger as "active" for a few minutes while it scales down —
that's normal; traffic is already 100% on the new one.)

### Environment variables & secrets

Config lives on the container app, **not** in git (`.env` is git-ignored). The
service account JSON is stored as a Container Apps **secret**.

```bash
# List what's set (names only):
az containerapp show -n conclave-backend -g rg-conclave-prod \
  --query "properties.template.containers[0].env[].name" -o tsv

# Add/replace a plain env var (e.g. widen CORS):
az containerapp update -n conclave-backend -g rg-conclave-prod \
  --set-env-vars CORS_ORIGINS="https://admin.example.com"

# Add/replace a secret, then reference it from an env var:
az containerapp secret set -n conclave-backend -g rg-conclave-prod \
  --secrets razorpay-secret="<value>"
az containerapp update -n conclave-backend -g rg-conclave-prod \
  --set-env-vars RAZORPAY_KEY_SECRET=secretref:razorpay-secret
```

Current keys: `FIREBASE_SERVICE_ACCOUNT` (secret), `FIREBASE_STORAGE_BUCKET`,
`PORT`, `NODE_ENV`, `CORS_ORIGINS`, `ALLOW_INSECURE_ADMIN`, `ENABLE_DEV_ROUTES`.
Razorpay keys are **not** set yet — add them (as above) when payments go live.
**Never commit `FIREBASE_SERVICE_ACCOUNT` or Razorpay keys.**

### Rollback

```bash
# See recent revisions and their images:
az containerapp revision list -n conclave-backend -g rg-conclave-prod \
  --query "[].{name:name, active:properties.active, created:properties.createdTime, image:properties.template.containers[0].image}" -o table

# Roll back = redeploy the previous revision's image digest:
az containerapp update -n conclave-backend -g rg-conclave-prod \
  --image "conclaveacr336510.azurecr.io/conclave-backend@sha256:<PREVIOUS_DIGEST>"
```

### Logs & health

```bash
az containerapp logs show -n conclave-backend -g rg-conclave-prod --follow
```

Alerts already exist (`conclave-backend-restarts`, `conclave-backend-down`) and
email `connect@manuen.com` on crash-loops or the app going down.

---

## 2. Admin panel → Vercel

The admin is a **Vite + React** single-page app. The only thing that ties it to
production is one env var — the backend URL — which must point at the Azure app.

```bash
cd <the admin repo>

# 1. Point it at the Azure backend. In the Vercel project's
#    Settings -> Environment Variables (Production), set:
#      VITE_API_URL = https://conclave-backend.blackpond-26884e90.centralindia.azurecontainerapps.io
#    (Locally, the same goes in .env for `npm run dev`.)

# 2. Build locally to catch errors before shipping:
npm ci
npm run build            # outputs dist/

# 3. Deploy:
vercel --prod            # explicit deploy
#   — or, if the Vercel project auto-builds from git, just push the
#     production branch and Vercel builds it.
```

> Vite bakes `VITE_*` vars in at **build time**, so after changing `VITE_API_URL`
> you must trigger a **new build** — redeploying an old build keeps the old URL.

If the admin is ever moved onto Azure, the equivalent is an **Azure Static Web
App** (`az staticwebapp create` + `swa deploy ./dist`) with the same
`VITE_API_URL` — but today it lives on Vercel.

---

## 3. Mobile apps → Play & App Store

These live in the **frontend** repo (`bni_121_conclave_frontend`) and have their
own detailed runbooks — follow those; here are the headlines.

```bash
cd ~/Documents/FlutterProjects/conclave_1_2_1
flutter analyze          # must be clean

# --- Android (Google Play) ---   full guide: scripts/RELEASE_RUNBOOK.md
scripts/release.sh --production --version X.Y.Z
#   builds the signed AAB, syncs the versionCode with Play, uploads to Production.

# --- iOS (App Store) ---         full guide: scripts/IOS_RELEASE_RUNBOOK.md
# Bump version in pubspec.yaml, then (RELEASE Xcode, normal shell):
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
flutter build ipa --release --export-method app-store
xcodebuild -exportArchive -archivePath build/ios/archive/Runner.xcarchive \
  -exportPath build/ios/ipa -exportOptionsPlist ios/ExportOptions.plist \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$HOME/.conclave-secrets/ASC_API_AuthKey_79TJL426G2.p8" \
  -authenticationKeyID 79TJL426G2 \
  -authenticationKeyIssuerID cb07fb7a-b51b-41a8-9466-d07c578a4790
cd ios && fastlane ios upload_only          # then: fastlane ios submit build:N
```

Gotchas that have bitten us (all covered in the runbooks):
- **iOS: use release Xcode 26.6**, never the beta, for store builds (Apple rejects
  beta-built binaries). Override per-command with `DEVELOPER_DIR`.
- **App Privacy label** must declare any new data collection *before* submitting,
  or Apple rejects under Guideline 5.1.2.
- **Play: no undeclared `AD_ID` permission** — the manifest strips it.

---

## Automate this next

When we script the backend deploy, wrap Section 1 as `scripts/deploy.sh`:
`git pull` → `tsc --noEmit` → `az acr build` → resolve digest → `containerapp
update` → poll `/health`, and fail loudly if any step fails. Keep the digest-pin
and the health check — they're the two things that make the deploy trustworthy.

---

*Last updated: 2026-09-22.*
