# Passkey Auth — Design Spec

**Date:** 2026-05-01
**Status:** Draft for review
**Owner:** João (jrflga)

## Goal

Replace the current "paste an `ADMIN_TOKEN`" prompt that the browser shows when the user opens `https://paizao.jardim.dev.br/` with a real login UX backed by passkey (WebAuthn). After registering once, hitting the URL on the same device should sign the user in via Touch ID / Face ID / hardware key without ever typing a token.

`ADMIN_TOKEN` stays as a Bearer / header / query fallback so that:

- CLI scripts and webhooks that already pass the token keep working unchanged.
- The first passkey can be registered using the token (no chicken-and-egg).
- If the user loses every passkeyed device, they can recover by editing `.env.local`.

## Non-goals

- Multi-user accounts. boop is single-user; storage and APIs treat the user as implicit "owner".
- Passkey revocation / management UI. v0 only supports register and sign-in. To revoke a passkey, edit the JSON store on disk and restart.
- Replay / cloning detection via WebAuthn `signCount`. Skipped deliberately — see *Trade-offs*.
- Mobile / native clients. The design targets the web browser at `paizao.jardim.dev.br` only. Telegram and other clients keep using `ADMIN_TOKEN`.
- Login UI inside the existing `debug/` React app. The login page is a standalone HTML served by Express; the React app is reached after the cookie is set.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  CLIENT (browser at paizao.jardim.dev.br)                     │
│  ├─ GET /login → login.html (vanilla JS)                      │
│  └─ uses @simplewebauthn/browser from unpkg CDN               │
│      ├─ navigator.credentials.create() (registration)          │
│      └─ navigator.credentials.get() (sign-in)                  │
└──────────────────────────┬───────────────────────────────────┘
                           │  HTTPS, cookie bp_session
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  EXPRESS SERVER                                               │
│  ├─ server/passkey.ts          ← config + challenge cache     │
│  ├─ server/auth-routes.ts      ← /auth/* + /login             │
│  ├─ server/http-auth.ts        ← middleware (cookie OR token) │
│  ├─ server/login.html          ← standalone login page        │
│  └─ verifies via @simplewebauthn/server                        │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  DISK (single file)                                           │
│  /opt/boop-agent/data/passkeys.json                            │
│  [{ credentialId, publicKey, transports }, ...]                │
│  owned boop:boop, mode 0600, gitignored                        │
└──────────────────────────────────────────────────────────────┘
```

**No Convex schema change.** Passkey state lives on disk. Session state lives in a signed cookie (no server-side session table).

**No new external service.** Library: `@simplewebauthn/server` for verification, `cookie-parser` for cookie signing. Both are runtime-only.

## Data model

### Disk store — `data/passkeys.json`

```ts
type StoredCredential = {
  credentialId: string;     // base64url
  publicKey: string;        // base64url, COSE_Key bytes
  transports: AuthenticatorTransport[];   // ["internal"], ["hybrid"], etc.
};

type Store = StoredCredential[];
```

Read at boot, cached in memory. Re-written atomically (`fs.writeFile` to `.tmp`, then `rename`) on each successful registration. Boot fails loudly if the file exists but is unparseable. Boot succeeds if the file is missing — the server starts with zero credentials and `/login` enters bootstrap mode.

### Session cookie — `bp_session`

Express signed cookie via `cookieParser(SESSION_SECRET)`. Value is the literal string `"valid"`; the HMAC signature is what proves the cookie was issued by us.

Flags:

- `HttpOnly` — JS can't read it.
- `Secure` — HTTPS only (skip in dev when `RP_ORIGIN` starts with `http://`).
- `SameSite=Lax` — submit on top-level navigations, block on cross-site iframes/forms.
- `Path=/` — cover everything.
- `Max-Age=2592000` (30 days) — sliding window: middleware refreshes the cookie's `Max-Age` on every authenticated hit, so an active user stays logged in indefinitely; an idle browser logs out after 30 days.

### Challenge cache — in-process

`Map<string, { challenge: string; expiresAt: number; intent: "register" | "login" }>`. Key is a random `challengeId` set as a short-lived cookie (`bp_challenge`, 5 min, HttpOnly, Secure, SameSite=Lax). On `/auth/.../finish`, the server looks up the challenge by reading the cookie, verifies, deletes the entry. Entries past `expiresAt` are evicted opportunistically on each lookup; a 60-second sweeper handles abandoned entries. Single-process boop means no shared cache needed.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/login` | none | Serves `server/login.html`. |
| `POST` | `/auth/login/start` | none | Returns WebAuthn auth options. Sets `bp_challenge` cookie. If zero credentials, returns `{ bootstrap: true }` instead. |
| `POST` | `/auth/login/finish` | none | Verifies assertion against stored credentials. On success, sets `bp_session` cookie. Clears `bp_challenge`. |
| `POST` | `/auth/register/start` | session OR `ADMIN_TOKEN` | Returns WebAuthn registration options. Sets `bp_challenge`. |
| `POST` | `/auth/register/finish` | session OR `ADMIN_TOKEN` | Verifies attestation, appends credential to `passkeys.json`, atomically rewrites the file. Clears `bp_challenge`. |
| `POST` | `/auth/logout` | none | Clears `bp_session`. Always 200. |

All other routes (and the `/ws` upgrade) keep their current behaviour — they pass through `requireAdminToken`, which is updated to also accept the cookie.

## Auth middleware (`server/http-auth.ts`)

```
function isAuthed(req):
  if cookie 'bp_session' is signed-valid → true
  if Authorization Bearer matches ADMIN_TOKEN → true
  if x-admin-token header matches ADMIN_TOKEN → true
  if ?admin_token query matches ADMIN_TOKEN → true
  else → false

middleware:
  if !ADMIN_TOKEN configured → 503 "ADMIN_TOKEN is not configured"
  if isAuthed → refresh bp_session Max-Age (sliding); next()
  else if request accepts text/html (browser navigation) → 302 to /login?next=<original path>
  else → 401 JSON { error: "auth required" }
```

`requireAdminToken` is renamed to `requireAuth` and becomes the single source of truth. `isAdminTokenValid` and `adminTokenFromUpgrade` are kept (used by the WebSocket `verifyClient`) but updated: they now also try the signed cookie before falling back to the token.

The `503` branch (no `ADMIN_TOKEN`) stays because the bootstrap flow needs the token to exist somewhere. Without it the user couldn't register the first passkey.

## Login UI (`server/login.html`)

Single self-contained file. Imports `@simplewebauthn/browser@11` from `https://unpkg.com/@simplewebauthn/browser@11/dist/bundle/index.umd.min.js`. ~120 lines including styles.

Two modes, picked from the `/auth/login/start` response:

**Sign-in mode** (default — store has ≥ 1 credential):

- Page shows "Sign in to boop" + a single button "Sign in with passkey".
- Button click: POST `/auth/login/start` → run `startAuthentication()` with the returned options → POST `/auth/login/finish` with the assertion → on 200, redirect to `?next=<...>` (or `/`).

**Bootstrap mode** (store is empty — first passkey):

- Page shows "Welcome — register your first passkey".
- One input for `ADMIN_TOKEN` (paste box, type=password).
- Optional input "label" — informational only, not stored in v0 (kept simple).
- Button "Register passkey": POST `/auth/register/start` with `Authorization: Bearer <token>` → run `startRegistration()` → POST `/auth/register/finish` → on 200, automatically run the sign-in flow → redirect to `?next=`.

**Errors:**

- WebAuthn unavailable (older browser, http://, etc.) → fallback link "Use admin token instead" that opens a paste box; on submit, sets a `bp_session` cookie via `POST /auth/token-login` (... see *Open question 1* below).
- Network / server errors → inline red text under the button.

No build step. No bundler involvement. The file is shipped as-is and read by Express.

## Failure modes

| Scenario | Behaviour |
|---|---|
| `SESSION_SECRET` env var missing | Process exits at boot with a clear error. No silent fallback. |
| `ADMIN_TOKEN` env var missing | All auth endpoints return 503 (existing behaviour). Login is impossible until env is fixed. |
| `passkeys.json` is missing | Server starts with zero credentials. `/login` enters bootstrap mode. |
| `passkeys.json` is corrupt | Server fails at boot with the parse error. Manual fix (delete the file or restore a backup). |
| `passkeys.json` write fails (disk full / permissions) | Registration endpoint returns 500. The new credential is **not** in memory either, so the user can retry. |
| Cookie signed with an old `SESSION_SECRET` | Middleware treats it as invalid → redirect to `/login`. The user signs in again, gets a fresh cookie. |
| Browser without WebAuthn support | Login page shows the admin-token fallback path. |

## Trade-offs

### No `signCount` tracking

WebAuthn lets servers detect cloned authenticators by tracking a counter that increments on each use. Skipping this means: if someone exfiltrates the private key from a Touch ID / Face ID / YubiKey enclave AND captures a valid WebAuthn assertion, both the original device and the clone could authenticate without us noticing.

For boop's threat model — single user, single admin tool, passkeys live in OS-managed enclaves — this risk is essentially "the attacker already has your phone". Accepting the trade-off lets us drop a Convex table or per-login disk write on the hot path.

If the threat model changes later (e.g., shared device, multiple users), reintroduce `signCount` by adding a `counter` column to the JSON store and rewriting the file on every successful sign-in.

### Cookie-only sessions (no server-side store)

We can't revoke a session before its 30-day lifetime expires without rotating `SESSION_SECRET` (which kicks out everyone). For a single user, "rotate the secret if you lose a device" is acceptable. A `sessions` table with revocation is the next natural step if we add multi-device or multi-user.

## Env vars

New:

- `SESSION_SECRET` — required. ≥ 32 chars. Generate with `openssl rand -hex 32`. Used to HMAC the cookie.
- `RP_ID` — required in prod, default `paizao.jardim.dev.br`. Override to `localhost` for dev.
- `RP_ORIGIN` — required, default `https://paizao.jardim.dev.br`. Override to `http://localhost:3456` (or whatever port) for dev.
- `PASSKEY_STORE` — optional, default `./data/passkeys.json` resolved against `process.cwd()`. Override to point elsewhere.

Updated `.env.example` documents all four.

## Code layout

| Path | Purpose | New / edit |
|---|---|---|
| `server/passkey.ts` | RP config, challenge cache, file load/save, `verifyRegistration` / `verifyAuthentication` wrappers. | new (~200 lines) |
| `server/auth-routes.ts` | Express router with `/login`, `/auth/login/{start,finish}`, `/auth/register/{start,finish}`, `/auth/logout`. | new (~150 lines) |
| `server/http-auth.ts` | Renamed middleware, dual cookie-or-token check. | edit (~50 lines added) |
| `server/login.html` | Standalone login page. | new (~120 lines) |
| `server/index.ts` | Mount `cookieParser`, mount `auth-routes`, keep middleware order: `/health`, `/telegram`, `auth-routes`, `requireAuth`, everything else. | edit (~10 lines) |
| `.gitignore` | Add `data/`. | edit (~1 line) |
| `.env.example` | Add the four new env vars with comments. | edit (~10 lines) |
| `package.json` | `@simplewebauthn/server@^11`, `cookie-parser@^1`, `@types/cookie-parser`. | edit |

Total ≈ 550 lines of new/changed code, no Convex schema change.

## Open questions

### Q1 — Admin-token fallback inside the login page

If a browser doesn't support WebAuthn, should `/login` accept the `ADMIN_TOKEN` directly (paste, click "Sign in", get a `bp_session` cookie) so the user gets the cookie ergonomics on legacy browsers? This adds one tiny endpoint (`POST /auth/token-login`) that takes the token in the body and sets the cookie if it matches. Maintains the "no token in URL bar" UX.

**Default plan:** include it. Cost is ~15 lines, recovers a useful fallback when passkeys are unavailable. Reject if you'd rather omit it.

### Q2 — Where to drop the `data/` directory at first deploy

The first deploy after this lands will not have `/opt/boop-agent/data/`. Options:

- a) Server `mkdir -p` at boot. Simplest, runs as user `boop` so permissions are right.
- b) One-time `ssh root@vps 'sudo -u boop mkdir -p /opt/boop-agent/data'`.

**Default plan:** (a). Reject if you'd rather not have the server touch the filesystem at boot.

## Testing

- **Unit:** `server/passkey.ts` exports a few pure helpers (encode/decode credentialId, JSON load/save) — direct vitest tests once vitest lands. Until then, doc-comment cases.
- **Integration:** an Express supertest covering `/auth/login/start` (with and without credentials), `/auth/login/finish` happy path with a mocked authenticator, and middleware redirect-vs-401 logic.
- **Manual smoke:** real browser dance on `https://paizao.jardim.dev.br/`:
  1. After deploy, hit `/`. Expect 302 to `/login`. Bootstrap mode (no credentials yet).
  2. Paste `ADMIN_TOKEN`, click "Register passkey". Touch ID prompt fires. Success → auto sign-in → land on `/` (debug UI).
  3. Open a private window, hit `/`. Expect 302 to `/login`. Sign-in mode. Click button. Touch ID prompt. Land on `/`.
  4. Curl `/composio/...` with `Authorization: Bearer <ADMIN_TOKEN>` — still works.
  5. Curl with no auth at all — 401.
- **Failure smoke:** corrupt `data/passkeys.json` → restart → expect boot failure with parse error.

## Roll-out

1. Land the PR. Auto-deploy via `.github/workflows/deploy.yml` triggers.
2. Set `SESSION_SECRET` in `/opt/boop-agent/.env.local` on the VPS *before* the deploy completes (otherwise the boot-time check fails the restart). `pm2 restart paizao --update-env` is part of the deploy, so the variable will be picked up.
3. Hit `/`, register the first passkey using `ADMIN_TOKEN`.
4. Verify Telegram bot still works (it doesn't go through admin auth, so it should).
5. Curl smoke test (`Bearer ADMIN_TOKEN` and no-auth) to confirm fallback.

## Out of scope

- Listing / labelling / revoking passkeys from a UI.
- Multi-device passkey sync UX hints (the OS handles this; we just register multiple credentials).
- Audit log of sign-ins.
- WebAuthn `userVerification: "required"` enforcement (we'll set `preferred`, which is enough for the personal-tool threat model).
- Sliding-window invalidation across processes (single-process boop makes this moot).
- HSTS / CSP / clickjacking protections beyond what Express defaults give us. Worth a separate hardening pass.
