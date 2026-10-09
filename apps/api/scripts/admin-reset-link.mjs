#!/usr/bin/env node
// Break-glass when no admin can log in: prints SQL (stdout) that creates a 24 h password-reset
// link for <email>, and the link itself (stderr). Feed the SQL to `wrangler d1 execute --command`.
// Usage: node apps/api/scripts/admin-reset-link.mjs <email> [base-url]
import { createHash, randomBytes, randomUUID } from "node:crypto";

const [email, base = "https://<your-kitelog-host>"] = process.argv.slice(2);
if (!email) {
  console.error("usage: node apps/api/scripts/admin-reset-link.mjs <email> [base-url]");
  process.exit(1);
}
const token = randomBytes(32).toString("base64url"); // same shape as @kitelog/auth randomToken()
const tokenHash = createHash("sha256").update(token).digest("hex");
const now = Date.now();
const e = email.trim().toLowerCase().replaceAll("'", "''");
const user = `(SELECT id FROM users WHERE email = '${e}')`;
console.log(
  `DELETE FROM password_resets WHERE used_at IS NULL AND user_id = ${user}; ` +
    `INSERT INTO password_resets (id, user_id, token_hash, created_by, expires_at, created_at) ` +
    `SELECT '${randomUUID()}', id, '${tokenHash}', NULL, ${now + 24 * 3600 * 1000}, ${now} FROM users WHERE email = '${e}';`,
);
console.error(`Reset link (valid 24 h, once): ${base.replace(/\/$/, "")}/reset#${token}`);
console.error("If wrangler reports 0 rows written, no user has that email.");
