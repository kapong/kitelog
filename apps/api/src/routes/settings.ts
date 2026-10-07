import { Hono } from "hono";
import { SettingsPatch, type Settings } from "@kitelog/shared";
import type { AppEnv, Env } from "../env";
import { body } from "../http";
import { requireAdmin, sessionAuth } from "../middleware/session";

async function read(env: Env): Promise<Settings> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'open_signup'").first<{ value: string }>();
  return { open_signup: row?.value === "true" };
}

export const settings = new Hono<AppEnv>();
settings.use(sessionAuth, requireAdmin);

settings.get("/", async (c) => c.json(await read(c.env)));

settings.patch("/", async (c) => {
  const patch = await body(c, SettingsPatch);
  if (patch.open_signup !== undefined) {
    await c.env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('open_signup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(String(patch.open_signup))
      .run();
  }
  return c.json(await read(c.env));
});
