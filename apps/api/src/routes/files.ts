import { Hono } from "hono";
import { encodeKey } from "@kitelog/storage";
import type { AppEnv } from "../env";
import { ApiError } from "../http";
import { storageFor } from "../lib";
import { requireMember } from "../middleware/member";
import { sessionAuth } from "../middleware/session";

// Mounted at /projects/:slug/files. Any member may download.
export const files = new Hono<AppEnv>();
files.use(sessionAuth, requireMember("viewer"));

/** Own S3: 302 to a presigned GET. Fallback R2: streamed through the Worker. */
files.get("/:fileId/download", async (c) => {
  const f = await c.env.DB.prepare("SELECT * FROM files WHERE id = ? AND project_id = ?")
    .bind(c.req.param("fileId"), c.get("project").id)
    .first<{ path: string; size: number; content_type: string | null; storage_key: string; backend: "r2" | "s3" }>();
  if (!f) throw new ApiError(404, "not_found", "file not found");
  const { storage, backend } = await storageFor(c.env, c.get("project").id);
  if (backend !== f.backend) throw new ApiError(410, "storage_changed", "file is in a storage tier this project no longer uses");
  if (storage.canPresign) return c.redirect(await storage.presignGet(f.storage_key, 3600), 302);
  const obj = await storage.get(f.storage_key);
  if (!obj) throw new ApiError(404, "not_found", "file object missing");
  const name = f.path.split("/").pop()!;
  return new Response(obj.body, {
    headers: {
      "Content-Type": f.content_type ?? "application/octet-stream",
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeKey(name)}`, // RFC 5987: also escapes '()*,
      // Client-chosen content type on our origin: never sniff or render it.
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
});
