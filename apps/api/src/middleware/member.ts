import { createMiddleware } from "hono/factory";
import { roleAtLeast } from "@kitelog/auth";
import type { Role } from "@kitelog/shared";
import type { AppEnv, ProjectRow } from "../env";
import { ApiError } from "../http";

/**
 * Resolves `:slug` to a project the session user is a member of, with at least `min` role.
 * Admins are NOT implicit members: admin = instance settings + invites only. Non-member and
 * unknown slug both → 404 (no existence leak); member with too low a role → 403.
 */
export const requireMember = (min: Role) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const row = await c.env.DB.prepare(
      `SELECT p.*, m.role FROM projects p
       JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
       WHERE p.slug = ?`,
    )
      .bind(c.get("user").id, c.req.param("slug") ?? "")
      .first<ProjectRow & { role: Role }>();
    if (!row) throw new ApiError(404, "not_found", "project not found");
    if (!roleAtLeast(row.role, min)) throw new ApiError(403, "forbidden", `requires ${min} role`);
    const { role, ...project } = row;
    c.set("project", project);
    c.set("role", role);
    await next();
  });
