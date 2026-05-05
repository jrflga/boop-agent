# Passkey Auth + Dashboard Serving — Design Spec

**Date:** 2026-05-01
**Status:** Draft for review
**Owner:** João (jrflga)

## Goal

Two coupled outcomes, shipped in one change:

1. Replace the current "paste an `ADMIN_TOKEN`" prompt that the browser shows when the user opens `https://paizao.jardim.dev.br/` with a real login UX backed by passkey (WebAuthn). After registering once, hitting the URL on the same device should sign the user in via Touch ID / Face ID / hardware key without ever typing a token.
2. Actually serve the existing `debug/` React app at `https://paizao.jardim.dev.br/` so there's something to log into. Today the URL only handles the Telegram webhook and 401s every other GET; the dashboard the user actually wants is built locally and never deployed.

`ADMIN_TOKEN` stays as a Bearer / header / query fallback so that:

- CLI scripts and automation that already pass the token keep working unchanged.
- The first passkey can be registered using the token (no chicken-and-egg).
- If the user loses every passkeyed device, they can recover by editing `.env.local`.
- Local dev keeps using the existing token-in-localStorage flow (no passkey for `localhost`).

## Non-goals

- Multi-user accounts. boop is single-user; storage and APIs treat the user as implicit "owner".
- Passkey revocation / management UI. v0 only supports register and sign-in. To revoke a passkey, edit the JSON store on disk and restart.
- Replay / cloning detection via WebAuthn `signCount`. Skipped deliberately — see *Trade-offs*.
- Mobile / native clients. The design targets the web browser at `paizao.jardim.dev.br` only. Telegram and other clients keep using `ADMIN_TOKEN`.
- Login UI inside the existing `debug/` React app. The login page is a standalone HTML served by Express; the React app is reached after the cookie is set.
- Passkey support for local dev. `localhost` keeps the existing `apiFetch` Bearer-from-localStorage flow.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  CLIENT (browser at paizao.jardim.dev.br)                     │
│  ├─ GET /            → debug/dist/index.html (public)         │
│  ├─ GET /assets/…    → debug bundle (public)                  │
│  ├─ GET /login       → server/login.html (public)             │
│  ├─ POST /auth/…     → register / login / logout (public)     │
│  ├─ /api/* fetches   → gated by cookie OR token               │
│  └─ /ws upgrade      → gated by cookie OR token               │
└──────────────────────────┬───────────────────────────────────┘
                           │  HTTPS via Caddy → Express :3456
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  EXPRESS SERVER                                               │
│  ├─ server/passkey.ts          ← RP config + challenge cache  │
│  ├─ server/auth-routes.ts      ← /auth/* + /login             │
│  ├─ server/http-auth.ts        ← gate (cookie OR token)       │
│  ├─ server/login.html          ← standalone login page        │
│  ├─ debug/dist (static, public)                                │
│  ├─ /api/* router (composio, chat, agents, consolidate…)       │
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

**No new external service.** Library: `@simplewebauthn/server` for verification, `cookie-parser` for cookie signing. Both runtime-only.

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

Read at boot, cached in memory. Re-written atomically (`fs.writeFile` to `.tmp`, then `rename`) on each successful registration. Boot fails loudly if the file exists but is unparseable. Boot succeeds if the file is missing — the server starts with zero credentials and `/login` enters bootstrap mode. Server `mkdir -p` of the parent dir at boot (decision Q2 below).

### Session cookie — `bp_session`

Express signed cookie via `cookieParser(SESSION_SECRET)`. Value is the literal string `"valid"`; the HMAC signature is what proves the cookie was issued by us.

Flags:

- `HttpOnly` — JS can't read it.
- `Secure` — HTTPS only (skipped automatically when `RP_ORIGIN` starts with `http://`, e.g. local dev).
- `SameSite=Lax` — submit on top-level navigations, block on cross-site iframes/forms.
- `Path=/` — cover everything.
- `Max-Age=2592000` (30 days) — sliding window: middleware refreshes the cookie's `Max-Age` on every authenticated hit, so an active user stays logged in indefinitely; an idle browser logs out after 30 days.

### Challenge cache — in-process

`Map<string, { challenge: string; expiresAt: number; intent: "register" | "login" }>`. Key is a random `challengeId` set as a short-lived cookie (`bp_challenge`, 5 min, HttpOnly, Secure-when-https, SameSite=Lax). On `/auth/.../finish`, the server looks up the challenge by reading the cookie, verifies, deletes the entry. Entries past `expiresAt` are evicted opportunistically on each lookup; a 60-second sweeper handles abandoned entries. Single-process boop means no shared cache needed.

## WebAuthn options

| Option | Value | Reason |
|---|---|---|
| `userVerification` | `"preferred"` | Touch ID / Face ID / OS PIN happens whenever the device supports it (almost always). Avoids hard-failing on edge hardware. |
| `residentKey` | `"preferred"` | Discoverable credentials enable usernameless flow. Falls back gracefully if hardware can't. |
| `attestation` | `"none"` | Personal tool; no attestation chain needed. Most private. |
| `authenticatorAttachment` | unset | Allow both platform (Touch ID, Windows Hello) and cross-platform (USB security key). |
| `timeout` | `60_000` ms | Standard. |

## Routing layout

The current Express layout has all routes at the root (`/composio`, `/chat`, `/consolidate`, etc.). With the React dashboard now served at `/`, those routes move under `/api` to keep the boundary clear and match what the React app already calls (`apiFetch("/api/composio/...")`).

| Path prefix | Purpose | Auth |
|---|---|---|
| `GET /` (and unmatched GETs that accept `text/html`) | Serves `debug/dist/index.html` (SPA shell). | none |
| `GET /assets/*`, `GET /favicon.*`, `GET /*.png` | Static assets from `debug/dist`. | none |
| `GET /login` | Login page. | none |
| `GET /health` | Health check. | none |
| `POST /telegram/webhook` (and other `/telegram/*`) | Telegram webhook. | none |
| `POST /auth/login/start` | WebAuthn auth challenge. | none |
| `POST /auth/login/finish` | WebAuthn auth verify; sets `bp_session`. | none |
| `POST /auth/register/start` | WebAuthn registration challenge. | session OR `ADMIN_TOKEN` |
| `POST /auth/register/finish` | WebAuthn registration verify; appends to `passkeys.json`. | session OR `ADMIN_TOKEN` |
| `POST /auth/logout` | Clears `bp_session`. | none |
| `POST /auth/token-login` | Pastes raw `ADMIN_TOKEN`, gets `bp_session` cookie if it matches. | none (rate-limited) |
| `/api/composio/*` | Composio routes. | gated |
| `/api/chat`, `/api/consolidate`, `/api/compact`, `/api/agents/:id/cancel`, `/api/agents/:id/retry` | Existing handlers, remounted. | gated |
| `WS /ws` | Live broadcast socket. | gated |

The "gated" middleware: cookie OR `ADMIN_TOKEN` (Bearer / header / query). On 401:

- If the request accepts `text/html` (browser navigation) → 302 to `/login?next=<original>`.
- Else (XHR / fetch / WS) → 401 JSON.

The dashboard's `apiFetch` handler is updated to detect 401 and redirect the page to `/login?next=` so the React app never has to render a "logged out" state itself.

## Endpoints

### Auth

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/login` | none | Serves `server/login.html`. |
| `POST` | `/auth/login/start` | none | Returns WebAuthn auth options. Sets `bp_challenge` cookie. If zero credentials, returns `{ bootstrap: true }` instead. |
| `POST` | `/auth/login/finish` | none | Verifies assertion against stored credentials. On success, sets `bp_session` cookie. Clears `bp_challenge`. |
| `POST` | `/auth/register/start` | session OR `ADMIN_TOKEN` | Returns WebAuthn registration options. Sets `bp_challenge`. |
| `POST` | `/auth/register/finish` | session OR `ADMIN_TOKEN` | Verifies attestation, appends credential to `passkeys.json`, atomically rewrites the file. Clears `bp_challenge`. |
| `POST` | `/auth/logout` | none | Clears `bp_session`. Always 200. |
| `POST` | `/auth/token-login` | none | Body `{ token: string }`. If matches `ADMIN_TOKEN`, sets `bp_session` cookie. 401 otherwise. Compares with `crypto.timingSafeEqual` to avoid timing leaks. ~20-line escape hatch for browsers without WebAuthn. |

### Dashboard

`GET /` is mapped to `res.sendFile(debug/dist/index.html)`. `app.use(express.static('debug/dist'))` serves the bundle (JS, CSS, images). The SPA fallback (`app.get('*', ...)`) returns `index.html` for any unmatched path that accepts `text/html`. This block is mounted **before** the gated `/api` router so static is always public.

## Auth middleware (`server/http-auth.ts`)

```
function isAuthed(req):
  if cookie 'bp_session' is signed-valid → true
  if Authorization Bearer matches ADMIN_TOKEN → true
  if x-admin-token header matches ADMIN_TOKEN → true
  if ?admin_token query matches ADMIN_TOKEN → true
  else → false

middleware (mounted on /api and the WS verifyClient):
  if !ADMIN_TOKEN configured → 503 "ADMIN_TOKEN is not configured"
  if isAuthed → refresh bp_session Max-Age (sliding); next()
  else if request accepts text/html (browser navigation) → 302 to /login?next=<original path>
  else → 401 JSON { error: "auth required" }
```

`requireAdminToken` is renamed to `requireAuth` and becomes the single source of truth. `isAdminTokenValid` and `adminTokenFromUpgrade` are kept (used by the WebSocket `verifyClient`) but updated: they now also try the signed cookie before falling back to the token.

The `503` branch (no `ADMIN_TOKEN`) stays because the bootstrap flow needs the token to exist somewhere. Without it the user couldn't register the first passkey.

## Login UI (`server/login.html`)

Single self-contained file. Imports `@simplewebauthn/browser@11` from `https://unpkg.com/@simplewebauthn/browser@11/dist/bundle/index.umd.min.js`. ~150 lines including styles.

Two modes, picked from the `/auth/login/start` response:

**Sign-in mode** (default — store has ≥ 1 credential):

- Page shows "Sign in to boop" + a single button "Sign in with passkey".
- Button click: POST `/auth/login/start` → run `startAuthentication()` with the returned options → POST `/auth/login/finish` with the assertion → on 200, `window.location = next ?? "/"`.

**Bootstrap mode** (store is empty — first passkey):

- Page shows "Welcome — register your first passkey".
- One input for `ADMIN_TOKEN` (paste box, type=password).
- Button "Register passkey": POST `/auth/register/start` with `Authorization: Bearer <token>` → run `startRegistration()` → POST `/auth/register/finish` → on 200, automatically run the sign-in flow → redirect to `?next=`.

**Errors / fallback:**

- WebAuthn unavailable (older browser, etc.) → fallback link "Use admin token instead" that opens a paste box; on submit, POST `/auth/token-login` to set `bp_session` and redirect.
- Network / server errors → inline red text under the button.

No build step. No bundler involvement. The file is shipped as-is and read by Express via `res.sendFile`.

## Dashboard build & deploy

The current `package.json` has `build:debug` (`vite build --config debug/vite.config.ts`) which writes to `debug/dist/`. That directory is gitignored, so it has to be produced on each deploy.

**Decision:** build runs in the GitHub Actions runner; the resulting `debug/dist/` is `scp`'d to the VPS into `/opt/boop-agent/debug/dist/`. The VPS's deploy script unconditionally `rm -rf`s and recreates the dir before `pm2 restart` so a partial sync can't leave stale assets.

Workflow changes (`.github/workflows/deploy.yml`):

- Add a `build-dashboard` job that runs `pnpm install --frozen-lockfile`, then `pnpm exec vite build --config debug/vite.config.ts`, then uploads `debug/dist/` as an artifact (or pipes via `scp` directly in the SSH job).
- The existing `vps` job grows a step before `pm2 restart`. The deploy SSHes as `root` (already configured), so:
  1. `scp -r debug/dist root@<host>:/opt/boop-agent/debug/dist.tmp` (root owns the temp dir).
  2. `ssh root@<host> 'cd /opt/boop-agent && chown -R boop:boop debug/dist.tmp && rm -rf debug/dist && mv debug/dist.tmp debug/dist'`. Ownership flipped to boop before the swap, so the runtime sees correctly-owned files. Atomic enough — if scp fails mid-way, only `debug/dist.tmp` is corrupt and the live `debug/dist` is untouched.
- The convex job remains unchanged.

The build runner sets `VITE_CONVEX_URL` (read from a repo variable, since Convex URLs are public-by-design) and **does not** export any other `VITE_*` env. The current `debug/src/lib/adminAuth.ts` references `VITE_ADMIN_TOKEN` for dev-time convenience; that reference is removed in this change (see *React app cleanup* below).

## React app cleanup (`debug/src/lib/adminAuth.ts`)

Today `apiFetch` calls `ensureAdminToken`, which prompts via `window.prompt` if `localStorage["boop-admin-token"]` is empty. Once the cookie path exists, the prompt is wrong UX (cookie auth is in flight, no need to ask). Updates:

- Remove the `window.prompt` and the `VITE_ADMIN_TOKEN` env reference.
- `apiFetch` becomes: read token from `localStorage`. If present, send `Authorization: Bearer <token>`. Always send `credentials: "same-origin"` so the cookie goes along.
- New: on `401` from any `apiFetch`, redirect to `/login?next=${encodeURIComponent(location.pathname + location.search)}` and short-circuit the caller. No "session expired" toast; the page just navigates.
- `withAdminToken(/ws)` keeps appending `?admin_token=` for the WS query param when localStorage has a token (dev workflow); cookie auth covers prod.

Result: in prod (cookie auth, no localStorage token), `apiFetch` sends only the cookie. In dev (token in localStorage), it sends both — server accepts either.

## Failure modes

| Scenario | Behaviour |
|---|---|
| `SESSION_SECRET` env var missing | Process exits at boot with a clear error. No silent fallback. |
| `ADMIN_TOKEN` env var missing | All gated endpoints return 503 (existing behaviour). Login is impossible until env is fixed. |
| `passkeys.json` is missing | Server starts with zero credentials. `/login` enters bootstrap mode. |
| `passkeys.json` is corrupt | Server fails at boot with the parse error. Manual fix (delete the file or restore a backup). |
| `passkeys.json` write fails (disk full / permissions) | Registration endpoint returns 500. The new credential is **not** in memory either, so the user can retry. |
| Cookie signed with an old `SESSION_SECRET` | Middleware treats it as invalid → redirect to `/login`. The user signs in again, gets a fresh cookie. |
| Browser without WebAuthn support | Login page shows the admin-token paste fallback (`/auth/token-login`). |
| `debug/dist/` missing on the VPS (first deploy not yet done, or scp failed) | `GET /` returns Express's default 404 HTML. `/login` still works (separate file). |
| Dashboard hits 401 mid-session (cookie expired) | `apiFetch` redirects the page to `/login?next=`; user signs in again and lands back on the same view. |

## Trade-offs

### No `signCount` tracking

WebAuthn lets servers detect cloned authenticators by tracking a counter that increments on each use. Skipping this means: if someone exfiltrates the private key from a Touch ID / Face ID / YubiKey enclave AND captures a valid WebAuthn assertion, both the original device and the clone could authenticate without us noticing.

For boop's threat model — single user, single admin tool, passkeys live in OS-managed enclaves — this risk is essentially "the attacker already has your phone". Accepting the trade-off lets us drop a Convex table or per-login disk write on the hot path.

If the threat model changes later (e.g., shared device, multiple users), reintroduce `signCount` by adding a `counter` field to the JSON store and rewriting the file on every successful sign-in.

### Cookie-only sessions (no server-side store)

We can't revoke a session before its 30-day lifetime expires without rotating `SESSION_SECRET` (which kicks out everyone). For a single user, "rotate the secret if you lose a device" is acceptable. A `sessions` table with revocation is the next natural step if we add multi-device or multi-user.

### Static assets are public

The `debug/dist/index.html` and JS bundle are served unauthenticated. The repo is public on GitHub, so the bundle is already discoverable. No secrets are baked in by Vite at build time (`VITE_CONVEX_URL` is the only `VITE_*` var the build runner exposes; Convex URLs are public-by-design). An anonymous visitor sees an empty React shell that 401s on every API call → redirects to `/login`. Acceptable.

### Build runs in CI, not on the VPS

The VPS doesn't need to know how to build — it only needs to run. The CI runner is fast and predictable; the VPS stays lean. Cost: a slightly more complex workflow with two jobs and an `scp` step.

## Env vars

New:

- `SESSION_SECRET` — required. ≥ 32 chars. Generate with `openssl rand -hex 32`. Used to HMAC the cookie.
- `RP_ID` — required, default `paizao.jardim.dev.br`. Override to `localhost` for dev.
- `RP_ORIGIN` — required, default `https://paizao.jardim.dev.br`. Override to `http://localhost:3456` (or whatever port) for dev.
- `PASSKEY_STORE` — optional, default `./data/passkeys.json` resolved against `process.cwd()` (= `/opt/boop-agent` in prod). Override to point elsewhere.

`.env.example` documents all four. The deploy expects `SESSION_SECRET` to be in `/opt/boop-agent/.env.local` **before** the first deploy after this PR lands; otherwise the boot-time check fails and `pm2 restart` leaves the previous version online.

## Code layout

| Path | Purpose | New / edit |
|---|---|---|
| `server/passkey.ts` | RP config, challenge cache, file load/save, `verifyRegistration` / `verifyAuthentication` wrappers. | new (~200 lines) |
| `server/auth-routes.ts` | Express router with `/login`, `/auth/login/{start,finish}`, `/auth/register/{start,finish}`, `/auth/logout`, `/auth/token-login`. | new (~200 lines) |
| `server/http-auth.ts` | Renamed middleware (`requireAuth`), dual cookie-or-token check, redirect-vs-401 by Accept header. | edit (~60 lines added) |
| `server/login.html` | Standalone login page. | new (~150 lines) |
| `server/index.ts` | Mount `cookieParser`, mount `auth-routes`, mount `/api` router with the existing handlers, mount `express.static('debug/dist')` + SPA fallback. Order: `/health`, `/telegram`, `/login`, `/auth/*`, static, SPA fallback (GETs only), `/api/*` (gated), WS `verifyClient`. | edit (~30 lines) |
| `debug/src/lib/adminAuth.ts` | Remove `window.prompt`, remove `VITE_ADMIN_TOKEN` reference, add 401 → `/login?next=` redirect in `apiFetch`. | edit (~20 lines) |
| `.github/workflows/deploy.yml` | New `build-dashboard` job; `vps` job gets an `scp` step + atomic-swap rm/mv. | edit (~25 lines) |
| `.gitignore` | Add `data/`. | edit (~1 line) |
| `.env.example` | Add the four new env vars with comments. | edit (~10 lines) |
| `package.json` | `@simplewebauthn/server@^11`, `cookie-parser@^1`, `@types/cookie-parser`. | edit |

Total ≈ 700 lines of new/changed code, no Convex schema change, no new external services.

## Resolved decisions (was: open questions)

1. **Admin-token fallback inside the login page** → **YES.** Adds `POST /auth/token-login` (~15 lines) so users on browsers without WebAuthn can still get the cookie ergonomics by pasting the token once.
2. **Where to create `data/` at first deploy** → **Server `mkdir -p` at boot.** Runs as user `boop`, permissions automatically right.

## Local dev

In dev, the workflow stays exactly as it is today:

- `pnpm dev` runs `vite` at `:5173` with the proxy to Express at `:3456`.
- `apiFetch` reads `localStorage["boop-admin-token"]` (you set it once via the browser console: `localStorage.setItem("boop-admin-token", "<your dev ADMIN_TOKEN>")`) and sends `Authorization: Bearer`.
- The cookie path is dormant — Express still accepts the Bearer in dev because the middleware accepts either.

Passkey registration is a prod-only thing. `RP_ID` must match the host the browser sees, and bouncing between `localhost` (dev) and `paizao.jardim.dev.br` (prod) would require two registrations on every device. Skipped.

Caveat: `SESSION_SECRET` becomes required everywhere (boot fails without it). Add a value to `.env.local` locally too — any random string works, it's only used to sign cookies you'll never use in dev.

## Testing

- **Unit:** `server/passkey.ts` exports a few pure helpers (encode/decode credentialId, JSON load/save) — direct vitest tests once vitest lands. Until then, doc-comment cases.
- **Integration:** an Express supertest covering `/auth/login/start` (with and without credentials), `/auth/login/finish` happy path with a mocked authenticator, `/auth/token-login` accept/reject, and middleware redirect-vs-401 logic.
- **Manual smoke** on `https://paizao.jardim.dev.br/`:
  1. After deploy, hit `/`. Dashboard shell loads (no auth needed for static). It calls `/api/...` → 401 → redirects to `/login?next=/`. Bootstrap mode shows up (no credentials yet).
  2. Paste `ADMIN_TOKEN`, click "Register passkey". Touch ID prompt fires. Success → auto sign-in → land on `/` (debug UI loads with cookie auth).
  3. Open a private window, hit `/`. Static shell loads. `apiFetch` 401s → redirect to `/login`. Sign-in mode. Touch ID. Land on `/`.
  4. Logout button → `POST /auth/logout` → cookie cleared → next `apiFetch` 401 → redirect to `/login`.
  5. Curl `/api/composio/...` with `Authorization: Bearer <ADMIN_TOKEN>` — works.
  6. Curl with no auth at all — 401.
  7. WebSocket `/ws` connect with cookie — succeeds.
- **Failure smoke:** corrupt `data/passkeys.json` → restart → expect boot failure with parse error.

## Roll-out

1. Set `SESSION_SECRET` in `/opt/boop-agent/.env.local` on the VPS (one-time). Generate with `openssl rand -hex 32`, append the line `SESSION_SECRET=<value>` to the file as user `boop`.
2. Add a GitHub Actions repo variable `VITE_CONVEX_URL=https://perfect-perch-395.convex.cloud` so the dashboard build can bake it in.
3. Land the PR. Auto-deploy via `.github/workflows/deploy.yml` triggers. Convex job + dashboard build + VPS deploy run; the VPS step now also `scp`s the dashboard bundle and `pm2 restart`s.
4. Hit `/` in a browser. The dashboard shell appears, calls `/api/...`, 401s, redirects to `/login`. Bootstrap mode shows. Paste `ADMIN_TOKEN`, register passkey.
5. Verify Telegram bot still works (the `/telegram/*` route is public, unchanged).
6. Curl smoke test (`Bearer ADMIN_TOKEN` against `/api/composio/...` → 200; no auth → 401).

## Out of scope

- Listing / labelling / revoking passkeys from a UI.
- Multi-device passkey sync UX hints (the OS handles this; we just register multiple credentials).
- Audit log of sign-ins.
- WebAuthn `userVerification: "required"` enforcement (we'll set `preferred`, which is enough for the personal-tool threat model).
- Sliding-window invalidation across processes (single-process boop makes this moot).
- HSTS / CSP / clickjacking protections beyond what Express defaults give us. Worth a separate hardening pass.
- Caddy `file_server` for static assets. Express serves them; if static-asset latency ever matters, move to Caddy.
- Removing the `package-lock.json` left over from before the pnpm switch. Cosmetic, separate PR.
