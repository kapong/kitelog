import { Hono } from "hono";
import { newInviteToken } from "@kitelog/auth";
import { InviteCreate, type Invite } from "@kitelog/shared";
import type { AppEnv } from "../env";
import { ApiError, body } from "../http";
import { requireAdmin, sessionAuth } from "../middleware/session";

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export const invites = new Hono<AppEnv>();
invites.use(sessionAuth, requireAdmin);

invites.post("/", async (c) => {
  const { email } = await body(c, InviteCreate);
  const { token, tokenHash } = await newInviteToken();
  const invite: Invite = { id: crypto.randomUUID(), email, expires_at: Date.now() + INVITE_TTL_MS, used_at: null };
  await c.env.DB.prepare(
    "INSERT INTO invites (id, email, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(invite.id, email, tokenHash, c.get("user").id, invite.expires_at)
    .run();
  return c.json({ ...invite, token }, 201); // raw token returned once
});

invites.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, email, expires_at, used_at FROM invites ORDER BY expires_at DESC",
  ).all<Invite>();
  return c.json(results);
});

invites.delete("/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM invites WHERE id = ?").bind(c.req.param("id")).run();
  if (r.meta.changes === 0) throw new ApiError(404, "not_found", "invite not found");
  return c.body(null, 204);
});
