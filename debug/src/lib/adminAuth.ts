const STORAGE_KEY = "boop-admin-token";

function envToken(): string {
  return import.meta.env.VITE_ADMIN_TOKEN?.trim?.() ?? "";
}

export function getAdminToken(): string {
  try {
    return localStorage.getItem(STORAGE_KEY)?.trim() || envToken();
  } catch {
    return envToken();
  }
}

export function setAdminToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token.trim());
  } catch {
    /* ignore */
  }
}

export function ensureAdminToken(): string {
  const existing = getAdminToken();
  if (existing) return existing;
  const entered = window.prompt("Admin token");
  if (!entered?.trim()) return "";
  setAdminToken(entered);
  return entered.trim();
}

export function withAdminToken(url: string): string {
  const token = ensureAdminToken();
  if (!token) return url;
  const u = new URL(url, window.location.origin);
  u.searchParams.set("admin_token", token);
  return u.pathname + u.search + u.hash;
}

export function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = ensureAdminToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
