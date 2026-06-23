import type { HttpResult, Session } from "./types.js";

const sessions = new Map<string, Session>();

export function rememberCookies(target: URL, response: HttpResult): void {
  const setCookie = response.headers["set-cookie"];
  if (!setCookie) return;

  const session = getSession(target);
  const cookies = Array.isArray(setCookie) ? setCookie : splitSetCookie(setCookie);
  for (const cookie of cookies) {
    const [pair] = cookie.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0) {
      session.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
}

export function cookieHeader(target: URL): string {
  const session = sessions.get(target.origin);
  if (!session) return "";
  return [...session.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export function clearSession(target: URL): void {
  sessions.delete(target.origin);
}

function getSession(target: URL): Session {
  let session = sessions.get(target.origin);
  if (!session) {
    session = { cookies: new Map() };
    sessions.set(target.origin, session);
  }
  return session;
}

function splitSetCookie(value: string): string[] {
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g);
}
