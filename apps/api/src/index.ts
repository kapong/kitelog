import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv, Env } from "./env";
import { ApiError } from "./http";
import { cron } from "./cron";
import { auth } from "./routes/auth";
import { admin } from "./routes/admin";
import { projects } from "./routes/projects";
import { members } from "./routes/members";
import { keys } from "./routes/keys";
import { storage } from "./routes/storage";
import { project } from "./routes/project";
import { projectRuns, runs } from "./routes/runs";
import { uploads } from "./routes/uploads";
import { files } from "./routes/files";

const api = new Hono<AppEnv>()
  // dashboard (session cookie)
  .route("/auth", auth)
  .route("/admin", admin)
  .route("/projects/:slug/members", members)
  .route("/projects/:slug/keys", keys)
  .route("/projects/:slug/storage", storage)
  .route("/projects/:slug/runs", projectRuns)
  .route("/projects/:slug/files", files)
  .route("/projects", projects)
  // client (API key)
  .route("/project", project)
  .route("/runs", runs)
  .route("/uploads", uploads); // body: upload-id capability; complete: API key

const app = new Hono<AppEnv>().route("/api/v1", api);

const err = (code: string, message: string, extra?: Record<string, unknown>) => ({ error: { code, message, ...extra } });

app.onError((e, c) => {
  if (e instanceof ApiError) return c.json(err(e.code, e.message, e.extra), e.status, e.headers);
  if (e instanceof HTTPException) return c.json(err("http_error", e.message), e.status);
  if (/UNIQUE constraint failed/.test(e.message)) return c.json(err("conflict", "resource already exists"), 409);
  // Path only (no query); the upload-id capability in the path is masked.
  const path = new URL(c.req.url).pathname.replace(/(\/uploads\/)[^/]+/, "$1:id");
  console.error("unhandled error", c.req.method, path, e);
  return c.json(err("internal", "internal error"), 500);
});

app.notFound((c) => c.json(err("not_found", "route not found"), 404));

export default {
  fetch: app.fetch,
  scheduled: (controller, env) => cron(controller, env),
} satisfies ExportedHandler<Env>;
