import type { Run } from "@kitelog/shared";

export const fmtTime = (ms: number | null) =>
  ms == null ? "—" : new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Wall time of a run: finished_at, else now (running) or the last sign of life. */
export function runDuration(r: Run, now = Date.now()): number {
  const end = r.finished_at ?? (r.status === "running" ? now : (r.heartbeat_at ?? r.updated_at));
  return Math.max(0, end - r.created_at);
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Compact metric value: 4 significant digits, exponent for very small / large. */
export function fmtValue(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
  return String(Number(v.toPrecision(4)));
}

export function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
}
