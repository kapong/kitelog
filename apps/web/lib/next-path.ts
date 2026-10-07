/**
 * Post-login redirect target from a `?next=` value: only a same-origin path with a single
 * leading slash (`//x` and `/\x` are protocol-relative to routers/browsers), never /login.
 * Anything else → `/projects`.
 */
export function safeNextPath(next: string | null, origin: string): string {
  if (!next) return "/projects";
  try {
    const u = new URL(next, origin);
    if (u.origin === origin && /^\/(?![/\\])/.test(u.pathname) && u.pathname !== "/login") {
      return u.pathname + u.search + u.hash;
    }
  } catch {
    /* fall through */
  }
  return "/projects";
}
