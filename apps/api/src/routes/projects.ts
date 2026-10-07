import { Hono } from "hono";
import { ProjectCreate, ProjectPatch } from "@kitelog/shared";
import type { AppEnv, ProjectRow } from "../env";
import { ApiError, body, projectOut } from "../http";
import { requireMember } from "../middleware/member";
import { sessionAuth } from "../middleware/session";

export const projects = new Hono<AppEnv>();
projects.use(sessionAuth);

// Any logged-in user may create a project; the creator becomes its owner.
projects.post("/", async (c) => {
  const input = await body(c, ProjectCreate);
  const db = c.env.DB;
  if (await db.prepare("SELECT 1 FROM projects WHERE slug = ?").bind(input.slug).first()) {
    throw new ApiError(409, "slug_taken", "project slug already exists");
  }
  const p: ProjectRow = {
    id: crypto.randomUUID(),
    slug: input.slug,
    name: input.name,
    description: input.description ?? null,
    created_at: Date.now(),
  };
  await db.batch([
    db
      .prepare("INSERT INTO projects (id, slug, name, description, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(p.id, p.slug, p.name, p.description, p.created_at),
    db
      .prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')")
      .bind(p.id, c.get("user").id),
  ]);
  return c.json(projectOut(p), 201);
});

projects.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id
     WHERE m.user_id = ? ORDER BY p.created_at DESC`,
  )
    .bind(c.get("user").id)
    .all<ProjectRow>();
  return c.json(results.map(projectOut));
});

projects.get("/:slug", requireMember("viewer"), (c) => c.json({ ...projectOut(c.get("project")), role: c.get("role") }));

projects.patch("/:slug", requireMember("owner"), async (c) => {
  const patch = await body(c, ProjectPatch);
  const p = { ...c.get("project") };
  if (patch.name !== undefined) p.name = patch.name;
  if (patch.description !== undefined) p.description = patch.description;
  await c.env.DB.prepare("UPDATE projects SET name = ?, description = ? WHERE id = ?")
    .bind(p.name, p.description, p.id)
    .run();
  return c.json(projectOut(p));
});

projects.delete("/:slug", requireMember("owner"), async (c) => {
  // FK cascades drop members, keys, runs, files, uploads, storage config.
  // ponytail: storage objects (R2 / own S3) are orphaned; delete them (prefix p/{id}/) later.
  await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(c.get("project").id).run();
  return c.body(null, 204);
});
