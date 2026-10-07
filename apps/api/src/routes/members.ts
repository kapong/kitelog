import { Hono } from "hono";
import { MemberAdd, MemberPatch, type Member } from "@kitelog/shared";
import type { AppEnv } from "../env";
import { ApiError, body } from "../http";
import { requireMember } from "../middleware/member";
import { sessionAuth } from "../middleware/session";

// Mounted at /projects/:slug/members.
export const members = new Hono<AppEnv>();
members.use(sessionAuth);

const LIST = `SELECT m.user_id, u.email, u.name, m.role FROM project_members m
  JOIN users u ON u.id = m.user_id WHERE m.project_id = ?`;

// Guard: the statement only applies when the target is not the last owner.
const NOT_LAST_OWNER = `(role != 'owner' OR (SELECT COUNT(*) FROM project_members WHERE project_id = ?1 AND role = 'owner') > 1)`;

members.get("/", requireMember("viewer"), async (c) => {
  const { results } = await c.env.DB.prepare(LIST + " ORDER BY u.email").bind(c.get("project").id).all<Member>();
  return c.json(results);
});

members.post("/", requireMember("owner"), async (c) => {
  const { email, role } = await body(c, MemberAdd);
  const pid = c.get("project").id;
  const user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (!user) throw new ApiError(404, "user_not_found", "no user with that email");
  const r = await c.env.DB.prepare(
    "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(pid, user.id, role)
    .run();
  if (r.meta.changes === 0) throw new ApiError(409, "already_member", "user is already a member");
  const m = await c.env.DB.prepare(LIST + " AND m.user_id = ?").bind(pid, user.id).first<Member>();
  return c.json(m, 201);
});

async function lastOwnerOrMissing(db: D1Database, pid: string, uid: string): Promise<never> {
  const exists = await db.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").bind(pid, uid).first();
  if (!exists) throw new ApiError(404, "not_found", "member not found");
  throw new ApiError(409, "last_owner", "a project must keep at least one owner");
}

members.patch("/:userId", requireMember("owner"), async (c) => {
  const { role } = await body(c, MemberPatch);
  const pid = c.get("project").id;
  const uid = c.req.param("userId");
  const r = await c.env.DB.prepare(
    `UPDATE project_members SET role = ?3 WHERE project_id = ?1 AND user_id = ?2 AND (?3 = 'owner' OR ${NOT_LAST_OWNER})`,
  )
    .bind(pid, uid, role)
    .run();
  if (r.meta.changes === 0) await lastOwnerOrMissing(c.env.DB, pid, uid);
  const m = await c.env.DB.prepare(LIST + " AND m.user_id = ?").bind(pid, uid).first<Member>();
  return c.json(m);
});

members.delete("/:userId", requireMember("owner"), async (c) => {
  const pid = c.get("project").id;
  const uid = c.req.param("userId");
  const r = await c.env.DB.prepare(`DELETE FROM project_members WHERE project_id = ?1 AND user_id = ?2 AND ${NOT_LAST_OWNER}`)
    .bind(pid, uid)
    .run();
  if (r.meta.changes === 0) await lastOwnerOrMissing(c.env.DB, pid, uid);
  return c.body(null, 204);
});
