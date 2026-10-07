import { Hono } from "hono";
import { resolveStorage, type ProjectStorageRow } from "@kitelog/storage";
import type { AppEnv } from "../env";
import { projectOut } from "../http";
import { apiKeyAuth } from "../middleware/apiKey";

// Client (API key) view of its own project: what it can save, never where.
export const project = new Hono<AppEnv>();
project.use(apiKeyAuth);

project.get("/", async (c) => {
  const p = c.get("project");
  const row = await c.env.DB.prepare("SELECT * FROM project_storage WHERE project_id = ?")
    .bind(p.id)
    .first<ProjectStorageRow>();
  const { capabilities } = await resolveStorage(row, c.env);
  return c.json({ project: projectOut(p), capabilities });
});
