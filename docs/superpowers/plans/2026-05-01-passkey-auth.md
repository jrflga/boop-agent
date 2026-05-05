# Passkey Auth + Dashboard Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the browser's `ADMIN_TOKEN` prompt with a real passkey login UX, and actually serve the existing `debug/` React dashboard at `https://paizao.jardim.dev.br/` behind that auth.

**Architecture:** Express grows: a static handler for `debug/dist`, an `/api/*` mount for the existing handlers, a `/auth/*` router for WebAuthn ceremonies, and a standalone `/login` HTML page. Credentials live in a single JSON file on disk; sessions are signed cookies. `ADMIN_TOKEN` stays as a Bearer fallback for CLI / scripts / break-glass.

**Tech Stack:** `@simplewebauthn/server@^11`, `cookie-parser@^1`, vanilla JS in the login page (`@simplewebauthn/browser` via unpkg).

**Spec:** `docs/superpowers/specs/2026-05-01-passkey-auth-design.md`

---

## Pre-flight

This plan executes on the `feature/passkey-auth` branch (already created and ahead of `main` with the spec commit). All commits should land there. Final PR targets `main`.

Project has no test runner yet (vitest is the planned future tool but isn't installed). Tasks rely on `pnpm exec tsc --noEmit` for verification of type-level changes and on a final manual smoke run on the dev deploy. Pure helpers in `server/passkey.ts` are written with isolated signatures so vitest tests can be backfilled later.

---

## Task 1: Add dependencies and ignore rules

**Files:**
- Modify: `package.json` (deps)
- Modify: `pnpm-lock.yaml` (auto-updated)
- Modify: `.gitignore` (add `data/`)
- Modify: `.env.example` (new env vars)

- [ ] **Step 1: Add runtime deps**

```bash
pnpm add @simplewebauthn/server@^11 cookie-parser@^1
```

Expected: lockfile updated, package.json has both new deps under `dependencies`.

- [ ] **Step 2: Add types**

```bash
pnpm add -D @types/cookie-parser
```

- [ ] **Step 3: Add `data/` to `.gitignore`**

Edit `.gitignore`. Append:

```
# Passkey credential store; managed by server/passkey.ts.
data/
```

- [ ] **Step 4: Document new env vars in `.env.example`**

Read `.env.example`, find a sensible insertion point (after `ADMIN_TOKEN` line). Insert:

```
# --- Passkey / web auth (server/passkey.ts) -----------------------------------
#
# Used to HMAC the bp_session cookie. Required at boot. Generate with:
#   openssl rand -hex 32
SESSION_SECRET=

# WebAuthn relying-party config. Must match the host the browser sees.
RP_ID=paizao.jardim.dev.br
RP_ORIGIN=https://paizao.jardim.dev.br

# Optional: where to store registered passkey credentials. Default
# resolves to ./data/passkeys.json against process.cwd() (=
# /opt/boop-agent in prod).
# PASSKEY_STORE=
```

- [ ] **Step 5: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore .env.example
git commit -m "chore(passkey): add @simplewebauthn/server + cookie-parser deps"
```

---

## Task 2: Move existing API routes under `/api`

The dashboard React app already calls `/api/composio/...` etc. The dev vite proxy strips `/api` before forwarding. In prod (same-origin), the prefix has to be honored by Express. This task remounts the routes; no behaviour change in dev because the proxy still works either way.

**Files:**
- Modify: `server/index.ts:33-91` (route mounts)
- Modify: `debug/vite.config.ts:18-26` (drop the `rewrite` since paths now match)

- [ ] **Step 1: Read the current Express layout**

Open `server/index.ts`. The block lines 33-91 has:

```ts
app.use("/telegram", createTelegramRouter());
app.use(requireAdminToken);
app.use("/composio", createComposioRouter());

app.post("/agents/:id/cancel", (req, res) => { ... });
app.post("/consolidate", async (_req, res) => { ... });
app.post("/compact", async (_req, res) => { ... });
app.post("/agents/:id/retry", async (req, res) => { ... });
app.post("/chat", async (req, res) => { ... });
```

- [ ] **Step 2: Wrap the gated routes in an `/api` router**

Replace the `app.use(requireAdminToken); app.use("/composio", ...);` and the four `app.post` lines with:

```ts
const apiRouter = express.Router();
apiRouter.use(requireAdminToken);
apiRouter.use("/composio", createComposioRouter());

apiRouter.post("/agents/:id/cancel", (req, res) => {
  const ok = cancelAgent(req.params.id);
  res.json({ ok });
});

apiRouter.post("/consolidate", async (_req, res) => {
  try {
    const { runConsolidation } = await import("./consolidation.js");
    runConsolidation("manual").catch((err) =>
      console.error("[consolidation] manual run failed", err),
    );
    res.json({ ok: true, triggered: "manual" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

apiRouter.post("/compact", async (_req, res) => {
  try {
    const { runCompaction } = await import("./consolidation.js");
    runCompaction("compact-manual").catch((err) =>
      console.error("[compaction] manual run failed", err),
    );
    res.json({ ok: true, triggered: "compact-manual" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

apiRouter.post("/agents/:id/retry", async (req, res) => {
  const result = await retryAgent(req.params.id);
  if (!result) {
    res.status(404).json({ error: "agent not found" });
    return;
  }
  res.json(result);
});

apiRouter.post("/chat", async (req, res) => {
  const { conversationId, content } = req.body ?? {};
  if (!conversationId || !content) {
    res.status(400).json({ error: "conversationId and content required" });
    return;
  }
  try {
    const reply = await handleUserMessage({ conversationId, content });
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

app.use("/api", apiRouter);
```

The `/telegram` mount stays where it is (above, not gated). The `/health` mount stays where it is (above, not gated).

- [ ] **Step 3: Update vite dev proxy**

Open `debug/vite.config.ts`. The `/api` proxy block currently has:

```ts
"/api": {
  target: `http://localhost:${port}`,
  rewrite: (p) => p.replace(/^\/api/, ""),
  ...
}
```

The rewrite is now wrong (Express expects `/api/...`, not the stripped form). Remove the `rewrite` line:

```ts
"/api": {
  target: `http://localhost:${port}`,
  configure: (proxy) => {
    proxy.on("error", () => {
      /* ignore — server may be restarting */
    });
  },
},
```

- [ ] **Step 4: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts debug/vite.config.ts
git commit -m "feat(api): mount existing handlers under /api prefix"
```

---

## Task 3: Serve `debug/dist` statically with SPA fallback

**Files:**
- Modify: `server/index.ts` (add static handlers near the top)

- [ ] **Step 1: Add `node:path` import if not present**

Open `server/index.ts`. Check the import block. If `path` isn't already imported, add at the top with the other imports:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
```

- [ ] **Step 2: Compute the dashboard path**

After `const app = express();` (around line 25), add:

```ts
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(__dirname, "..", "debug", "dist");
```

- [ ] **Step 3: Mount static + SPA fallback BEFORE the `/api` router**

After `app.get("/health", ...)` and before the `/api` mount, add:

```ts
// Dashboard (debug React app). Static assets are public; the API
// behind /api/* and the WebSocket are gated. The bundle has no
// secrets in it (only VITE_CONVEX_URL, public-by-design).
app.use(express.static(dashboardDir, { index: false, fallthrough: true }));
app.get(/^\/(?!api\/|auth\/|telegram\/|health$|ws$|login$).*/, (req, res, next) => {
  if (!req.accepts("text/html")) {
    next();
    return;
  }
  const indexPath = path.join(dashboardDir, "index.html");
  res.sendFile(indexPath, (err) => {
    if (err) next(err);
  });
});
```

The regex on `app.get` excludes `/api/`, `/auth/`, `/telegram/`, `/health`, `/ws`, and `/login` from the SPA fallback. Anything else that accepts `text/html` gets `index.html`.

- [ ] **Step 4: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat(server): serve debug/dist as SPA static, public"
```

---

## Task 4: Create `server/passkey.ts` (storage + WebAuthn config)

This module owns: the relying-party config, the on-disk credential store, the in-process challenge cache, and thin wrappers around `@simplewebauthn/server` verification helpers.

**Files:**
- Create: `server/passkey.ts`

- [ ] **Step 1: Write `server/passkey.ts`**

Create the file with these contents:

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type GenerateRegistrationOptionsOpts,
  type VerifyRegistrationResponseOpts,
  type GenerateAuthenticationOptionsOpts,
  type VerifyAuthenticationResponseOpts,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server/script/deps";

// Single-user system: every credential belongs to the implicit "owner".
// The userId is a constant byte array (32 bytes of zero) so registrations
// from different devices land under the same handle.
const OWNER_USER_ID = new Uint8Array(32);
const OWNER_USERNAME = "owner";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type StoredCredential = {
  credentialId: string; // base64url
  publicKey: string;    // base64url-encoded COSE_Key bytes
  transports: AuthenticatorTransportFuture[];
};

type Store = StoredCredential[];

type ChallengeIntent = "register" | "login";

type ChallengeEntry = {
  challenge: string;
  expiresAt: number;
  intent: ChallengeIntent;
};

// --- RP config (env-driven) ---------------------------------------------------

export type RpConfig = {
  rpID: string;
  rpName: string;
  origin: string;
};

export function loadRpConfig(): RpConfig {
  const rpID = process.env.RP_ID;
  const origin = process.env.RP_ORIGIN;
  if (!rpID) throw new Error("RP_ID is not set");
  if (!origin) throw new Error("RP_ORIGIN is not set");
  return { rpID, rpName: "boop", origin };
}

// --- Disk store ---------------------------------------------------------------

function storePath(): string {
  return process.env.PASSKEY_STORE
    ? path.resolve(process.env.PASSKEY_STORE)
    : path.resolve(process.cwd(), "data", "passkeys.json");
}

export class PasskeyStore {
  private credentials: StoredCredential[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  static async load(): Promise<PasskeyStore> {
    const filePath = storePath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const store = new PasskeyStore(filePath);
    try {
      const buf = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(buf) as Store;
      if (!Array.isArray(parsed)) {
        throw new Error("passkeys.json is not an array");
      }
      store.credentials = parsed;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // first boot, no credentials yet
        store.credentials = [];
      } else {
        throw new Error(
          `failed to load ${filePath}: ${(err as Error).message}`,
        );
      }
    }
    return store;
  }

  list(): StoredCredential[] {
    return this.credentials.slice();
  }

  count(): number {
    return this.credentials.length;
  }

  find(credentialId: string): StoredCredential | undefined {
    return this.credentials.find((c) => c.credentialId === credentialId);
  }

  async append(cred: StoredCredential): Promise<void> {
    if (this.find(cred.credentialId)) return; // idempotent
    this.credentials = [...this.credentials, cred];
    await this.persist();
  }

  private async persist(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(
      tmp,
      JSON.stringify(this.credentials, null, 2),
      { mode: 0o600 },
    );
    await fs.rename(tmp, this.filePath);
  }
}

// --- Challenge cache ----------------------------------------------------------

export class ChallengeCache {
  private cache = new Map<string, ChallengeEntry>();

  put(intent: ChallengeIntent, challenge: string): string {
    const id = randomToken();
    this.cache.set(id, {
      challenge,
      intent,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return id;
  }

  takeMatching(id: string, intent: ChallengeIntent): string | null {
    const entry = this.cache.get(id);
    this.cache.delete(id);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) return null;
    if (entry.intent !== intent) return null;
    return entry.challenge;
  }

  sweep(now = Date.now()): void {
    for (const [id, entry] of this.cache.entries()) {
      if (entry.expiresAt < now) this.cache.delete(id);
    }
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

// --- WebAuthn ceremony helpers ------------------------------------------------

export async function buildRegistrationOptions(
  rp: RpConfig,
  store: PasskeyStore,
): Promise<ReturnType<typeof generateRegistrationOptions>> {
  const opts: GenerateRegistrationOptionsOpts = {
    rpID: rp.rpID,
    rpName: rp.rpName,
    userID: OWNER_USER_ID,
    userName: OWNER_USERNAME,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials: store.list().map((c) => ({
      id: c.credentialId,
      transports: c.transports,
    })),
    timeout: 60_000,
  };
  return generateRegistrationOptions(opts);
}

export async function consumeRegistration(
  rp: RpConfig,
  expectedChallenge: string,
  response: RegistrationResponseJSON,
): Promise<StoredCredential> {
  const verifyOpts: VerifyRegistrationResponseOpts = {
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    requireUserVerification: false,
  };
  const verified = await verifyRegistrationResponse(verifyOpts);
  if (!verified.verified || !verified.registrationInfo) {
    throw new Error("registration verification failed");
  }
  const info = verified.registrationInfo;
  return {
    credentialId: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
    transports: response.response.transports ?? [],
  };
}

export async function buildAuthenticationOptions(
  rp: RpConfig,
  store: PasskeyStore,
): Promise<ReturnType<typeof generateAuthenticationOptions>> {
  const opts: GenerateAuthenticationOptionsOpts = {
    rpID: rp.rpID,
    userVerification: "preferred",
    allowCredentials: store.list().map((c) => ({
      id: c.credentialId,
      transports: c.transports,
    })),
    timeout: 60_000,
  };
  return generateAuthenticationOptions(opts);
}

export async function consumeAuthentication(
  rp: RpConfig,
  expectedChallenge: string,
  store: PasskeyStore,
  response: AuthenticationResponseJSON,
): Promise<StoredCredential> {
  const stored = store.find(response.id);
  if (!stored) throw new Error("unknown credential");
  const verifyOpts: VerifyAuthenticationResponseOpts = {
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: {
      id: stored.credentialId,
      publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
      counter: 0,
    },
    requireUserVerification: false,
  };
  const verified = await verifyAuthenticationResponse(verifyOpts);
  if (!verified.verified) {
    throw new Error("authentication verification failed");
  }
  return stored;
}

// --- Singleton wiring ---------------------------------------------------------

let _store: PasskeyStore | null = null;
let _challenges: ChallengeCache | null = null;
let _rp: RpConfig | null = null;
let _sweeper: NodeJS.Timeout | null = null;

export async function initPasskey(): Promise<{
  rp: RpConfig;
  store: PasskeyStore;
  challenges: ChallengeCache;
}> {
  if (_store && _challenges && _rp) {
    return { rp: _rp, store: _store, challenges: _challenges };
  }
  _rp = loadRpConfig();
  _store = await PasskeyStore.load();
  _challenges = new ChallengeCache();
  if (!_sweeper) {
    _sweeper = setInterval(() => _challenges?.sweep(), 60_000);
    _sweeper.unref();
  }
  return { rp: _rp, store: _store, challenges: _challenges };
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors. If `@simplewebauthn/server` types complain, double-check the version is `^11`.

- [ ] **Step 3: Commit**

```bash
git add server/passkey.ts
git commit -m "feat(passkey): add config, store and challenge cache module"
```

---

## Task 5: Replace `requireAdminToken` with `requireAuth` (cookie OR token)

The middleware now accepts a signed `bp_session` cookie or any of the existing `ADMIN_TOKEN` channels. Returns 302 to `/login` on browser navigations and 401 JSON on XHR/WS. Refreshes the session cookie's `Max-Age` on every authenticated hit (sliding window).

**Files:**
- Modify: `server/http-auth.ts` (rewrite middleware)
- Modify: `server/index.ts` (mount `cookieParser` and rename usage)

- [ ] **Step 1: Rewrite `server/http-auth.ts`**

Replace the file entirely with:

```ts
import type express from "express";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "bp_session";
const SESSION_COOKIE_VALUE = "valid";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function configuredAdminToken(): string | null {
  return process.env.ADMIN_TOKEN?.trim() || null;
}

function tokenFromAuthHeader(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function safeEq(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

function tokenMatches(token: string | null): boolean {
  const expected = configuredAdminToken();
  return Boolean(expected && token && safeEq(token, expected));
}

export function adminTokenFromRequest(req: express.Request): string | null {
  return (
    tokenFromAuthHeader(req.get("authorization")) ??
    req.get("x-admin-token")?.trim() ??
    (typeof req.query.admin_token === "string" ? req.query.admin_token : null)
  );
}

export function adminTokenFromUpgrade(req: IncomingMessage): string | null {
  const auth = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const headerToken = Array.isArray(req.headers["x-admin-token"])
    ? req.headers["x-admin-token"][0]
    : req.headers["x-admin-token"];
  const url = new URL(req.url ?? "/", "http://localhost");
  return tokenFromAuthHeader(auth) ?? headerToken?.trim() ?? url.searchParams.get("admin_token");
}

export function isAdminTokenValid(token: string | null): boolean {
  return tokenMatches(token);
}

function hasValidSessionCookie(req: express.Request): boolean {
  // cookie-parser populates req.signedCookies when the cookie has the
  // .sig suffix; an invalid signature returns false and leaves the
  // cookie out of req.signedCookies entirely.
  return req.signedCookies?.[SESSION_COOKIE] === SESSION_COOKIE_VALUE;
}

function hasValidSessionUpgrade(req: IncomingMessage, signer: (val: string) => string | null): boolean {
  // Lightweight cookie parse for the WS upgrade path; cookie-parser
  // doesn't run on the upgrade event.
  const raw = req.headers.cookie;
  if (!raw) return false;
  const target = raw
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${SESSION_COOKIE}=`));
  if (!target) return false;
  const signed = decodeURIComponent(target.slice(SESSION_COOKIE.length + 1));
  // cookie-parser format is "s:<value>.<sig>". signer.unsign returns
  // the original value or false.
  const verified = signer(signed);
  return verified === SESSION_COOKIE_VALUE;
}

function isAuthed(req: express.Request): boolean {
  if (hasValidSessionCookie(req)) return true;
  return tokenMatches(adminTokenFromRequest(req));
}

function setSessionCookie(res: express.Response): void {
  const secure = (process.env.RP_ORIGIN ?? "").startsWith("https://");
  res.cookie(SESSION_COOKIE, SESSION_COOKIE_VALUE, {
    signed: true,
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearSessionCookie(res: express.Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function issueSession(res: express.Response): void {
  setSessionCookie(res);
}

export function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const expected = configuredAdminToken();
  if (!expected) {
    res.status(503).json({ error: "ADMIN_TOKEN is not configured" });
    return;
  }
  if (!isAuthed(req)) {
    if (req.accepts(["html", "json"]) === "html") {
      const next = encodeURIComponent(req.originalUrl || "/");
      res.redirect(302, `/login?next=${next}`);
    } else {
      res.status(401).json({ error: "auth required" });
    }
    return;
  }
  // Sliding window: re-issue the session cookie so an active browser
  // never expires. Token-only auth (no cookie) is left alone.
  if (hasValidSessionCookie(req)) setSessionCookie(res);
  next();
}

export function buildUpgradeAuthChecker(
  unsign: (signed: string) => string | false,
): (req: IncomingMessage) => boolean {
  return (req) => {
    const cookieValid = hasValidSessionUpgrade(req, (val) => {
      const r = unsign(val);
      return r === false ? null : r;
    });
    if (cookieValid) return true;
    return tokenMatches(adminTokenFromUpgrade(req));
  };
}
```

- [ ] **Step 2: Mount cookie-parser in `server/index.ts`**

In `server/index.ts`, after `app.use(cors())` (line 26), add:

```ts
import cookieParser from "cookie-parser";
import { sign as signCookie, unsign as unsignCookie } from "cookie-signature";

const sessionSecret = process.env.SESSION_SECRET?.trim();
if (!sessionSecret || sessionSecret.length < 16) {
  throw new Error("SESSION_SECRET is not set or is too short (min 16 chars)");
}
app.use(cookieParser(sessionSecret));
```

`cookie-signature` ships transitively as a peer of `cookie-parser`, but if TypeScript can't find it, run:

```bash
pnpm add cookie-signature
pnpm add -D @types/cookie-signature
```

- [ ] **Step 3: Update WS `verifyClient` to accept cookie too**

In `server/index.ts`, find the `WebSocketServer` block (~line 94):

```ts
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: (info: { req: Parameters<typeof adminTokenFromUpgrade>[0] }) =>
    isAdminTokenValid(adminTokenFromUpgrade(info.req)),
});
```

Replace with:

```ts
const upgradeAuth = buildUpgradeAuthChecker((signed) =>
  unsignCookie(signed.startsWith("s:") ? signed.slice(2) : signed, sessionSecret),
);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: (info) => upgradeAuth(info.req),
});
```

Update the imports near the top of the file:

```ts
import {
  adminTokenFromUpgrade,
  isAdminTokenValid,
  requireAuth,
  buildUpgradeAuthChecker,
} from "./http-auth.js";
```

- [ ] **Step 4: Rename middleware usage in `apiRouter`**

Change:

```ts
apiRouter.use(requireAdminToken);
```

to:

```ts
apiRouter.use(requireAuth);
```

(The `requireAdminToken` export is gone after Task 5 Step 1.)

- [ ] **Step 5: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors. If `cookie-signature` types are missing, install them per Step 2.

- [ ] **Step 6: Commit**

```bash
git add server/http-auth.ts server/index.ts package.json pnpm-lock.yaml
git commit -m "feat(auth): replace requireAdminToken with cookie-or-token requireAuth"
```

---

## Task 6: Add `server/auth-routes.ts` (login / register / logout / token-login)

**Files:**
- Create: `server/auth-routes.ts`

- [ ] **Step 1: Write `server/auth-routes.ts`**

```ts
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  initPasskey,
  buildRegistrationOptions,
  consumeRegistration,
  buildAuthenticationOptions,
  consumeAuthentication,
} from "./passkey.js";
import {
  adminTokenFromRequest,
  isAdminTokenValid,
  issueSession,
  clearSessionCookie,
  requireAuth,
} from "./http-auth.js";

const CHALLENGE_COOKIE = "bp_challenge";

function setChallengeCookie(res: express.Response, value: string): void {
  const secure = (process.env.RP_ORIGIN ?? "").startsWith("https://");
  res.cookie(CHALLENGE_COOKIE, value, {
    signed: true,
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 5 * 60 * 1000,
  });
}

function clearChallengeCookie(res: express.Response): void {
  res.clearCookie(CHALLENGE_COOKIE, { path: "/" });
}

function readChallengeCookie(req: express.Request): string | null {
  const v = req.signedCookies?.[CHALLENGE_COOKIE];
  return typeof v === "string" ? v : null;
}

export async function createAuthRouter(): Promise<express.Router> {
  const { rp, store, challenges } = await initPasskey();
  const router = express.Router();

  // GET /login → static html (served by server/index.ts via sendFile, not here).

  router.post("/login/start", async (_req, res) => {
    if (store.count() === 0) {
      res.json({ bootstrap: true });
      return;
    }
    const opts = await buildAuthenticationOptions(rp, store);
    const id = challenges.put("login", opts.challenge);
    setChallengeCookie(res, id);
    res.json(opts);
  });

  router.post("/login/finish", async (req, res) => {
    try {
      const challengeId = readChallengeCookie(req);
      if (!challengeId) {
        res.status(400).json({ error: "no challenge" });
        return;
      }
      const expected = challenges.takeMatching(challengeId, "login");
      if (!expected) {
        res.status(400).json({ error: "challenge expired or unknown" });
        return;
      }
      await consumeAuthentication(rp, expected, store, req.body);
      clearChallengeCookie(res);
      issueSession(res);
      res.json({ ok: true });
    } catch (err) {
      res.status(401).json({ error: (err as Error).message });
    }
  });

  // Register requires existing session OR ADMIN_TOKEN. Use the same
  // requireAuth middleware that gates /api.
  router.post("/register/start", requireAuth, async (_req, res) => {
    const opts = await buildRegistrationOptions(rp, store);
    const id = challenges.put("register", opts.challenge);
    setChallengeCookie(res, id);
    res.json(opts);
  });

  router.post("/register/finish", requireAuth, async (req, res) => {
    try {
      const challengeId = readChallengeCookie(req);
      if (!challengeId) {
        res.status(400).json({ error: "no challenge" });
        return;
      }
      const expected = challenges.takeMatching(challengeId, "register");
      if (!expected) {
        res.status(400).json({ error: "challenge expired or unknown" });
        return;
      }
      const credential = await consumeRegistration(rp, expected, req.body);
      await store.append(credential);
      clearChallengeCookie(res);
      // After bootstrap registration, issue a session so the user can
      // proceed without a second sign-in dance.
      issueSession(res);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/logout", (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Escape hatch for browsers without WebAuthn: paste the token,
  // server hands back a session cookie. Same trust as the Bearer
  // header path; just shifts the credential into a cookie.
  router.post("/token-login", (req, res) => {
    const body = req.body as { token?: unknown } | undefined;
    const token =
      typeof body?.token === "string" ? body.token.trim() :
      adminTokenFromRequest(req);
    if (!isAdminTokenValid(token)) {
      res.status(401).json({ error: "invalid token" });
      return;
    }
    issueSession(res);
    res.json({ ok: true });
  });

  return router;
}

export function loginHtmlPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(dir, "login.html");
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/auth-routes.ts
git commit -m "feat(auth): add /auth/* routes for passkey + token-login"
```

---

## Task 7: Add `server/login.html`

**Files:**
- Create: `server/login.html`

- [ ] **Step 1: Write `server/login.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark light" />
    <title>boop · sign in</title>
    <style>
      :root {
        --bg: #0c0d10;
        --fg: #e7e9ee;
        --muted: #8a8f99;
        --card: #15171c;
        --line: #23262d;
        --accent: #7aa2f7;
        --error: #f7768e;
      }
      @media (prefers-color-scheme: light) {
        :root {
          --bg: #f7f8fa;
          --fg: #1a1b1f;
          --muted: #6c727f;
          --card: #ffffff;
          --line: #e3e6ec;
          --accent: #4f6df5;
          --error: #c53d49;
        }
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      body {
        background: var(--bg);
        color: var(--fg);
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 32px;
        width: min(380px, 92vw);
      }
      h1 { font-size: 18px; margin: 0 0 4px; }
      p.muted { color: var(--muted); margin: 0 0 24px; }
      button {
        width: 100%;
        height: 40px;
        border: 0;
        border-radius: 8px;
        background: var(--accent);
        color: #fff;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      button[disabled] { opacity: 0.5; cursor: not-allowed; }
      button.ghost {
        background: transparent;
        color: var(--muted);
        border: 1px solid var(--line);
      }
      input {
        width: 100%;
        height: 40px;
        padding: 0 12px;
        border: 1px solid var(--line);
        background: var(--bg);
        color: var(--fg);
        border-radius: 8px;
        font: inherit;
      }
      label { display: block; font-size: 12px; color: var(--muted); margin: 16px 0 6px; }
      .err { color: var(--error); margin-top: 12px; min-height: 18px; font-size: 13px; }
      .row { display: flex; gap: 8px; margin-top: 12px; }
      .row > * { flex: 1; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1 id="title">Sign in to boop</h1>
      <p class="muted" id="subtitle">Use your passkey to continue.</p>

      <div id="signin">
        <button id="btn-signin">Sign in with passkey</button>
      </div>

      <div id="register" hidden>
        <label for="bootstrap-token">Admin token</label>
        <input id="bootstrap-token" type="password" autocomplete="off" />
        <div class="row">
          <button id="btn-register">Register passkey</button>
        </div>
      </div>

      <div class="row" id="fallback-row" hidden>
        <button class="ghost" id="btn-token-fallback">Use admin token instead</button>
      </div>

      <div id="token-fallback" hidden>
        <label for="token-input">Admin token</label>
        <input id="token-input" type="password" autocomplete="off" />
        <div class="row">
          <button id="btn-token-submit">Sign in with token</button>
        </div>
      </div>

      <div class="err" id="err"></div>
    </div>

    <script type="module">
      const SWA_URL = "https://unpkg.com/@simplewebauthn/browser@11/dist/bundle/index.umd.min.js";
      const next = new URLSearchParams(location.search).get("next") || "/";
      const $ = (id) => document.getElementById(id);
      const errBox = $("err");

      const setErr = (msg) => { errBox.textContent = msg ?? ""; };
      const showFallback = () => { $("fallback-row").hidden = false; };

      async function loadSimpleWebAuthn() {
        if (window.SimpleWebAuthnBrowser) return window.SimpleWebAuthnBrowser;
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = SWA_URL;
          s.onload = res;
          s.onerror = () => rej(new Error("Failed to load WebAuthn helper"));
          document.head.appendChild(s);
        });
        return window.SimpleWebAuthnBrowser;
      }

      async function postJson(url, body) {
        const r = await fetch(url, {
          method: "POST",
          headers: body ? { "content-type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
          credentials: "same-origin",
        });
        if (!r.ok) throw new Error(`${url} -> ${r.status}: ${await r.text()}`);
        return r.json();
      }

      async function startLogin() {
        setErr("");
        try {
          const opts = await postJson("/auth/login/start");
          if (opts.bootstrap) {
            renderBootstrap();
            return;
          }
          const swa = await loadSimpleWebAuthn();
          const assertion = await swa.startAuthentication({ optionsJSON: opts });
          await postJson("/auth/login/finish", assertion);
          location.href = next;
        } catch (e) {
          setErr(e.message || String(e));
          showFallback();
        }
      }

      async function startRegister(token) {
        setErr("");
        try {
          const startRes = await fetch("/auth/register/start", {
            method: "POST",
            headers: { "authorization": `Bearer ${token}` },
            credentials: "same-origin",
          });
          if (!startRes.ok) throw new Error(`register/start ${startRes.status}: ${await startRes.text()}`);
          const opts = await startRes.json();
          const swa = await loadSimpleWebAuthn();
          const attestation = await swa.startRegistration({ optionsJSON: opts });
          const finishRes = await fetch("/auth/register/finish", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "authorization": `Bearer ${token}`,
            },
            credentials: "same-origin",
            body: JSON.stringify(attestation),
          });
          if (!finishRes.ok) throw new Error(`register/finish ${finishRes.status}: ${await finishRes.text()}`);
          location.href = next;
        } catch (e) {
          setErr(e.message || String(e));
        }
      }

      async function tokenLogin(token) {
        setErr("");
        try {
          await postJson("/auth/token-login", { token });
          location.href = next;
        } catch (e) {
          setErr("Token rejected.");
        }
      }

      function renderBootstrap() {
        $("title").textContent = "Welcome to boop";
        $("subtitle").textContent = "Paste your admin token to register your first passkey.";
        $("signin").hidden = true;
        $("register").hidden = false;
      }

      $("btn-signin").addEventListener("click", startLogin);
      $("btn-register").addEventListener("click", () => {
        const t = $("bootstrap-token").value.trim();
        if (!t) { setErr("Token required."); return; }
        startRegister(t);
      });
      $("btn-token-fallback").addEventListener("click", () => {
        $("fallback-row").hidden = true;
        $("token-fallback").hidden = false;
      });
      $("btn-token-submit").addEventListener("click", () => {
        const t = $("token-input").value.trim();
        if (!t) { setErr("Token required."); return; }
        tokenLogin(t);
      });

      // Auto-start the login probe so bootstrap mode shows up without a
      // click when the store is empty.
      startLogin();
    </script>
  </body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add server/login.html
git commit -m "feat(auth): add standalone /login HTML page"
```

---

## Task 8: Wire auth routes + login HTML into `server/index.ts`

**Files:**
- Modify: `server/index.ts` (mount order)

- [ ] **Step 1: Mount the auth router and the /login handler**

After the `cookieParser` mount and BEFORE the `app.use(express.static(...))` block (so `/login` and `/auth/*` win over the SPA fallback), add:

```ts
import { createAuthRouter, loginHtmlPath } from "./auth-routes.js";
// ... (other imports)

app.get("/login", (_req, res) => {
  res.sendFile(loginHtmlPath());
});
app.use("/auth", await createAuthRouter());
```

`createAuthRouter` is async because it triggers `initPasskey` which loads the JSON store. The `await` works because Express setup is happening inside `async function main()`.

- [ ] **Step 2: Confirm mount order**

The block of mounts in `main()` should now read:

```ts
app.get("/health", ...);
app.use("/telegram", createTelegramRouter());

app.get("/login", ...);
app.use("/auth", await createAuthRouter());

app.use(express.static(dashboardDir, ...));
app.get(/^\/(?!api\/|...)/, ...);

app.use("/api", apiRouter);  // gated by requireAuth inside the router

const server = createServer(app);
const wss = new WebSocketServer(...);
```

- [ ] **Step 3: Type-check**

```bash
pnpm exec tsc --noEmit
```

- [ ] **Step 4: Boot smoke (optional, requires SESSION_SECRET in .env.local)**

```bash
SESSION_SECRET=$(openssl rand -hex 32) RP_ID=localhost RP_ORIGIN=http://localhost:3456 ADMIN_TOKEN=dev pnpm exec tsx server/index.ts &
sleep 2
curl -s http://localhost:3456/health    # expect 200
curl -s http://localhost:3456/login     # expect login.html bytes
curl -s -X POST http://localhost:3456/auth/login/start   # expect {"bootstrap":true}
curl -s http://localhost:3456/api/composio/toolkits      # expect 401
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat(auth): mount /login + /auth routes into Express"
```

---

## Task 9: React app cleanup (`debug/src/lib/adminAuth.ts`)

**Files:**
- Modify: `debug/src/lib/adminAuth.ts` (drop window.prompt, drop VITE_ADMIN_TOKEN, redirect on 401)

- [ ] **Step 1: Replace `debug/src/lib/adminAuth.ts`**

```ts
const STORAGE_KEY = "boop-admin-token";

export function getAdminToken(): string {
  try {
    return localStorage.getItem(STORAGE_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function setAdminToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token.trim());
  } catch {
    /* ignore */
  }
}

function redirectToLogin(): void {
  const next = encodeURIComponent(location.pathname + location.search);
  location.href = `/login?next=${next}`;
}

export function withAdminToken(url: string): string {
  // Used for the WebSocket query param fallback in dev. In prod the
  // cookie covers the upgrade.
  const token = getAdminToken();
  if (!token) return url;
  const u = new URL(url, window.location.origin);
  u.searchParams.set("admin_token", token);
  return u.pathname + u.search + u.hash;
}

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = getAdminToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(input, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new Error("auth required (redirecting to /login)");
  }
  return res;
}
```

- [ ] **Step 2: Confirm no other call site uses `ensureAdminToken`**

```bash
grep -r "ensureAdminToken" debug/src/
```

Expected: no matches. The export was removed in the rewrite.

- [ ] **Step 3: Type-check**

```bash
pnpm exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add debug/src/lib/adminAuth.ts
git commit -m "feat(debug): drop prompt + redirect to /login on 401"
```

---

## Task 10: CI workflow — build dashboard + scp to VPS

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Add `build-dashboard` job and adjust `vps` job**

Replace `.github/workflows/deploy.yml` with the following. The `convex` job stays as-is; `build-dashboard` is new; `vps` job depends on `build-dashboard` and gains an `scp` step.

```yaml
name: Deploy

# Triggers on every push to main (and manual dispatch). Three jobs:
#   - convex: pushes Convex functions/schema (uses CONVEX_DEPLOY_KEY).
#   - build-dashboard: builds debug/dist on the runner; uploads artifact.
#   - vps: SSHes the VPS as root, downloads the artifact, scps the
#          dashboard bundle, runs git fetch + pnpm install as boop, then
#          pm2 restarts the app as root.

on:
  push:
    branches: [main]
  workflow_dispatch: {}

concurrency:
  group: deploy-main
  cancel-in-progress: false

jobs:
  convex:
    name: Convex deploy
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Convex deploy
        env:
          CONVEX_DEPLOY_KEY: ${{ secrets.CONVEX_DEPLOY_KEY }}
        run: pnpm exec convex deploy --yes

  build-dashboard:
    name: Build dashboard bundle
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Build vite bundle
        env:
          VITE_CONVEX_URL: ${{ vars.VITE_CONVEX_URL }}
        run: pnpm exec vite build --config debug/vite.config.ts
      - uses: actions/upload-artifact@v4
        with:
          name: dashboard-dist
          path: debug/dist
          retention-days: 1

  vps:
    name: VPS deploy
    runs-on: ubuntu-latest
    timeout-minutes: 10
    needs: [build-dashboard]
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: dashboard-dist
          path: debug-dist

      - name: Start SSH agent
        uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: ${{ secrets.SSH_DEPLOY_KEY }}

      - name: Trust server host key
        run: |
          mkdir -p ~/.ssh
          ssh-keyscan -p "${{ secrets.SSH_PORT || 22 }}" "${{ secrets.SSH_HOST }}" >> ~/.ssh/known_hosts
          chmod 600 ~/.ssh/known_hosts

      - name: Sync dashboard to VPS
        env:
          SSH_HOST: ${{ secrets.SSH_HOST }}
          SSH_PORT: ${{ secrets.SSH_PORT || 22 }}
          SSH_USER: ${{ secrets.SSH_USER || 'root' }}
          INSTALL_DIR: ${{ vars.INSTALL_DIR || '/opt/boop-agent' }}
          APP_USER: ${{ vars.APP_USER || 'boop' }}
        run: |
          # Push the bundle into a temp dir on the VPS, then atomically swap.
          ssh -o StrictHostKeyChecking=yes -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "rm -rf '$INSTALL_DIR/debug/dist.tmp' && mkdir -p '$INSTALL_DIR/debug/dist.tmp'"
          scp -o StrictHostKeyChecking=yes -P "$SSH_PORT" -r debug-dist/. "$SSH_USER@$SSH_HOST:$INSTALL_DIR/debug/dist.tmp/"
          ssh -o StrictHostKeyChecking=yes -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" "chown -R '$APP_USER:$APP_USER' '$INSTALL_DIR/debug/dist.tmp' && rm -rf '$INSTALL_DIR/debug/dist' && mv '$INSTALL_DIR/debug/dist.tmp' '$INSTALL_DIR/debug/dist'"

      - name: Deploy server over SSH
        env:
          SSH_HOST: ${{ secrets.SSH_HOST }}
          SSH_PORT: ${{ secrets.SSH_PORT || 22 }}
          SSH_USER: ${{ secrets.SSH_USER || 'root' }}
          INSTALL_DIR: ${{ vars.INSTALL_DIR || '/opt/boop-agent' }}
          PM2_PROCESS: ${{ vars.PM2_PROCESS || 'paizao' }}
          APP_USER: ${{ vars.APP_USER || 'boop' }}
        run: |
          ssh -o StrictHostKeyChecking=yes -p "$SSH_PORT" "$SSH_USER@$SSH_HOST" \
            "INSTALL_DIR='$INSTALL_DIR' PM2_PROCESS='$PM2_PROCESS' APP_USER='$APP_USER' bash -s" <<'REMOTE'
          set -euo pipefail
          cd "$INSTALL_DIR"
          echo "[1/3] git fetch + reset to origin/main (as $APP_USER)"
          sudo -u "$APP_USER" git fetch --prune origin
          sudo -u "$APP_USER" git reset --hard origin/main
          echo "[2/3] pnpm install --frozen-lockfile (as $APP_USER)"
          sudo -u "$APP_USER" -H bash -c "cd '$INSTALL_DIR' && CI=true pnpm install --frozen-lockfile"
          echo "[3/3] pm2 restart $PM2_PROCESS"
          pm2 restart "$PM2_PROCESS" --update-env
          pm2 save
          REMOTE
```

- [ ] **Step 2: Add `VITE_CONVEX_URL` repo variable**

In the `jrflga/boop-agent` repo Settings → Secrets and variables → Actions → Variables, add:

```
VITE_CONVEX_URL=https://perfect-perch-395.convex.cloud
```

This must be set BEFORE merging — the `build-dashboard` job needs it.

- [ ] **Step 3: Validate YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))"
```

Expected: silent success.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: build dashboard in CI, scp dist to VPS"
```

---

## Task 11: Pre-merge checklist + open PR

This task isn't code; it's the gates the user has to walk through before merging. Don't skip it — the deploy will fail without these.

- [ ] **Step 1: Set `SESSION_SECRET` on the VPS**

```bash
ssh jardim-vps 'sudo -u boop bash -c "openssl rand -hex 32 | (echo -n SESSION_SECRET= && cat) >> /opt/boop-agent/.env.local"'
```

Verify:

```bash
ssh jardim-vps 'sudo -u boop grep ^SESSION_SECRET= /opt/boop-agent/.env.local'
```

Expected: `SESSION_SECRET=<64-hex-chars>`.

- [ ] **Step 2: Add `RP_ID` and `RP_ORIGIN` on the VPS**

```bash
ssh jardim-vps 'sudo -u boop bash -c "echo RP_ID=paizao.jardim.dev.br >> /opt/boop-agent/.env.local"'
ssh jardim-vps 'sudo -u boop bash -c "echo RP_ORIGIN=https://paizao.jardim.dev.br >> /opt/boop-agent/.env.local"'
```

- [ ] **Step 3: Confirm `VITE_CONVEX_URL` is a repo variable**

```bash
gh variable list --repo jrflga/boop-agent | grep VITE_CONVEX_URL
```

Expected: a row showing the value. If absent, add via UI or `gh variable set`.

- [ ] **Step 4: Open the PR**

```bash
git push -u fork feature/passkey-auth
gh pr create --repo jrflga/boop-agent --base main --head jrflga:feature/passkey-auth \
  --title "feat: passkey auth + serve dashboard at paizao.jardim.dev.br" \
  --body "$(cat docs/superpowers/specs/2026-05-01-passkey-auth-design.md)"
```

- [ ] **Step 5: Merge**

After review, merge via GitHub UI. The `deploy.yml` workflow runs automatically.

---

## Task 12: Post-deploy smoke test

- [ ] **Step 1: Watch the workflow**

```bash
gh run watch --repo jrflga/boop-agent
```

Expected: all three jobs (`convex`, `build-dashboard`, `vps`) green.

- [ ] **Step 2: Verify static + API health**

In a private browser window:

1. Navigate to `https://paizao.jardim.dev.br/`. Expected: dashboard shell loads (no auth needed for static), then triggers a fetch that 401s, then redirects to `/login`.
2. `/login` shows bootstrap mode (no credentials yet) — input field for admin token.
3. Paste `ADMIN_TOKEN`, click "Register passkey". Touch ID prompt fires. Success → redirect to `/`. Dashboard renders.
4. Open another private window. Navigate to `/`. Expected: redirect to `/login`. Sign-in mode this time. Click button. Touch ID. Land on `/`.

- [ ] **Step 3: CLI smoke**

```bash
curl -sI -H "Authorization: Bearer $ADMIN_TOKEN" https://paizao.jardim.dev.br/api/composio/toolkits | head -1
# Expected: HTTP/2 200 (or whatever the route returns; the point is it's not 401)

curl -sI https://paizao.jardim.dev.br/api/composio/toolkits | head -1
# Expected: HTTP/2 401
```

- [ ] **Step 4: WebSocket smoke**

Open the dashboard while logged in (cookie-authed). The `Activity` panel should populate via WS — if it does, cookie auth on the upgrade works.

- [ ] **Step 5: Telegram smoke**

Send any message to the boop Telegram bot. Expect a normal response. The `/telegram/*` route is public, so this should be unaffected.

---

## Self-review

(This was run after writing the plan and before saving. Issues found and fixed inline below.)

**Spec coverage:**

- Goal (passkey + dashboard serving) → Tasks 1–12 ✓
- /api remount → Task 2 ✓
- Static + SPA fallback → Task 3 ✓
- Disk store + RP config + challenge cache → Task 4 ✓
- requireAuth (cookie OR token, sliding cookie, 302 vs 401) → Task 5 ✓
- /auth/* routes (login, register, logout, token-login) → Task 6 ✓
- Login HTML → Task 7 ✓
- Mount everything → Task 8 ✓
- React app cleanup → Task 9 ✓
- CI workflow + scp → Task 10 ✓
- Env vars + repo variable + roll-out → Tasks 11, 12 ✓
- WebAuthn options (preferred UV/resident, none attestation) → Task 4 ✓
- Failure modes (boot exit on missing SESSION_SECRET, mkdir on boot) → Tasks 4, 5 ✓

**Placeholder scan:** No "TBD" or "implement later". Code blocks are complete. Commands are runnable.

**Type consistency:** `requireAuth` is the new name everywhere it appears. `issueSession` / `clearSessionCookie` / `buildUpgradeAuthChecker` are exported from `http-auth.ts` (Task 5) and consumed in `auth-routes.ts` (Task 6) and `index.ts` (Tasks 5, 8). `initPasskey` returns `{ rp, store, challenges }` and is called both in `auth-routes.ts` (Task 6) and indirectly during boot via the same module (eager initialization on first import).
