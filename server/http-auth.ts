import type express from "express";
import type { IncomingMessage } from "node:http";

function configuredAdminToken(): string | null {
  return process.env.ADMIN_TOKEN?.trim() || null;
}

function tokenFromAuthHeader(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
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
  const expected = configuredAdminToken();
  return Boolean(expected && token && token === expected);
}

export function requireAdminToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const expected = configuredAdminToken();
  if (!expected) {
    res.status(503).json({ error: "ADMIN_TOKEN is not configured" });
    return;
  }
  if (!isAdminTokenValid(adminTokenFromRequest(req))) {
    res.status(401).json({ error: "admin token required" });
    return;
  }
  next();
}
