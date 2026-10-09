import type { ZodType } from "zod";
import type { Context } from "hono";
import type { AppEnv, ProjectRow, UserRow } from "./env";

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 500,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new ApiError(400, "invalid_input", i ? `${i.path.join(".") || "body"}: ${i.message}` : "invalid input");
  }
  return r.data;
}

export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  // Only JSON: blocks cross-site form posts (text/plain etc.) that skip CORS preflight.
  if (!/^application\/json\b/i.test(c.req.header("Content-Type") ?? "")) {
    throw new ApiError(400, "invalid_input", "Content-Type must be application/json");
  }
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_input", "body must be JSON");
  }
  return parse(schema, data);
}

export const userOut = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  is_admin: u.is_admin === 1,
  created_at: u.created_at,
});

export const projectOut = (p: ProjectRow) => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  description: p.description,
  created_at: p.created_at,
});

/** Per `CF-Connecting-IP` + subject (lowercased email) on the AUTH_LIMITER binding; 429 when over. */
export async function rateLimit(c: Context<AppEnv>, subject: string): Promise<void> {
  const limiter = c.env.AUTH_LIMITER;
  if (!limiter) return;
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await limiter.limit({ key: `${ip}:${subject.toLowerCase()}` });
  if (!success) throw new ApiError(429, "rate_limited", "too many attempts, try again in a minute", undefined, { "Retry-After": "60" });
}
