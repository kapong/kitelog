"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Project, RunStatus, RunWithMetrics } from "@kitelog/shared";
import { api, errMsg, runCursor } from "@/lib/api";
import { fmtDuration, fmtTime, fmtValue, runDuration } from "@/lib/format";
import { usePoll } from "@/lib/hooks";
import { Button, Card, Input, Select, cn } from "@/components/ui";
import { MAX_SERIES } from "@/components/charts/palette";
import { StatusBadge, Tag } from "./StatusBadge";

const PAGE = 50;
const AUTO_COLS = 6;

/** Newest-first merge by id: `fresh` replaces loaded rows; unseen fresh rows are prepended. */
function merge(cur: RunWithMetrics[], fresh: RunWithMetrics[]) {
  const by = new Map(fresh.map((r) => [r.id, r]));
  const known = new Set(cur.map((r) => r.id));
  return [...fresh.filter((r) => !known.has(r.id)), ...cur.map((r) => by.get(r.id) ?? r)];
}

export function RunsTable({ project }: { project: Project }) {
  const slug = project.slug;
  const router = useRouter();
  const [runs, setRuns] = useState<RunWithMetrics[] | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<RunStatus | "">("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [cols, setCols] = useState<string[] | null>(null); // null = auto (most common keys)
  const [, tick] = useState(0); // re-render running durations on poll

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      try {
        const page = await api.runs(slug, { before, limit: PAGE });
        setRuns((cur) => (before && cur ? [...cur, ...page] : page));
        setMore(page.length === PAGE);
        setError("");
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [slug],
  );
  useEffect(() => void load(), [load]);

  const runsRef = useRef(runs);
  runsRef.current = runs;
  const anyRunning = !!runs?.some((r) => r.status === "running");
  usePoll(async () => {
    const cur = runsRef.current ?? [];
    try {
      const first = await api.runs(slug, { limit: PAGE });
      const seen = new Set(first.map((r) => r.id));
      // Running runs beyond the first page: refresh individually (bounded).
      const rest = cur.filter((r) => r.status === "running" && !seen.has(r.id)).slice(0, 10);
      const extra = await Promise.all(rest.map((r) => api.run(slug, r.id).catch(() => r)));
      setRuns((c) => merge(c ?? [], [...first, ...extra]));
      tick((t) => t + 1);
    } catch {
      /* keep showing the last good data */
    }
  }, anyRunning);

  // Metric keys by how many loaded runs have them.
  const allKeys = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of runs ?? []) for (const k of Object.keys(r.metrics)) n.set(k, (n.get(k) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  }, [runs]);
  const shown = useMemo(() => (cols ?? allKeys.slice(0, AUTO_COLS)).filter((k) => allKeys.includes(k)), [cols, allKeys]);

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (runs ?? []).filter(
      (r) =>
        (!status || r.status === status) &&
        (!s || r.name.toLowerCase().includes(s) || r.id.includes(s) || r.tags.some((t) => t.toLowerCase().includes(s))),
    );
  }, [runs, status, q]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < MAX_SERIES ? [...s, id] : s));

  if (error && !runs) return <p className="text-sm text-red-600">{error}</p>;
  if (!runs) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (!runs.length)
    return (
      <Card>
        <p className="text-sm text-zinc-500">
          No runs yet. Log one from Python with <code className="font-mono">kl.init(project=&quot;{slug}&quot;)</code> and an API key from{" "}
          <Link href={`/projects/${slug}/settings`} className="text-sky-600 hover:underline">
            Settings
          </Link>
          .
        </p>
      </Card>
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-60">
          <Input className="h-8" placeholder="Search name, id, tag" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search runs" />
        </div>
        <div className="w-36">
          <Select className="h-8" value={status} onChange={(e) => setStatus(e.target.value as RunStatus | "")} aria-label="Status filter">
          <option value="">All statuses</option>
          {(["running", "finished", "failed", "crashed"] as const).map((s) => (
            <option key={s}>{s}</option>
          ))}
          </Select>
        </div>
        <ColumnPicker all={allKeys} shown={shown} onChange={setCols} />
        <div className="flex-1" />
        {selected.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            Clear
          </Button>
        )}
        <Button
          size="sm"
          disabled={selected.length < 2}
          title={selected.length < 2 ? `Select 2–${MAX_SERIES} runs to compare` : undefined}
          onClick={() => router.push(`/projects/${slug}/compare?runs=${selected.map(encodeURIComponent).join(",")}`)}
        >
          Compare{selected.length ? ` (${selected.length})` : ""}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
              <th className="w-8 px-3 py-2" />
              <th className="px-2 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Created</th>
              <th className="px-2 py-2 font-medium">Duration</th>
              <th className="px-2 py-2 font-medium">Tags</th>
              {shown.map((k) => (
                <th key={k} className="max-w-36 truncate px-2 py-2 text-right font-mono font-medium" title={k}>
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {visible.map((r) => {
              const sel = selected.includes(r.id);
              return (
                <tr key={r.id} className={cn("hover:bg-zinc-50 dark:hover:bg-zinc-800/50", sel && "bg-sky-50/60 dark:bg-sky-950/30")}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name}`}
                      checked={sel}
                      disabled={!sel && selected.length >= MAX_SERIES}
                      onChange={() => toggle(r.id)}
                      className="accent-sky-600"
                    />
                  </td>
                  <td className="max-w-64 truncate px-2 py-2">
                    <Link href={`/projects/${slug}/runs/${r.id}`} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-2 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-zinc-500">{fmtTime(r.created_at)}</td>
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums text-zinc-500">{fmtDuration(runDuration(r))}</td>
                  <td className="px-2 py-2">
                    <div className="flex max-w-48 flex-wrap gap-1">
                      {r.tags.map((t) => (
                        <Tag key={t}>{t}</Tag>
                      ))}
                    </div>
                  </td>
                  {shown.map((k) => (
                    <td key={k} className="whitespace-nowrap px-2 py-2 text-right font-mono text-xs tabular-nums">
                      {fmtValue(r.metrics[k]?.value)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {!visible.length && (
              <tr>
                <td colSpan={6 + shown.length} className="px-2 py-6 text-center text-zinc-500">
                  No loaded runs match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>
          {visible.length} of {runs.length} loaded runs{anyRunning && " · refreshing every 15 s"}
        </span>
        {error && <span className="text-red-600">{error}</span>}
        {more && (
          <Button variant="secondary" size="sm" disabled={loading} onClick={() => load(runCursor(runs[runs.length - 1]))}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </div>
  );
}

function ColumnPicker({ all, shown, onChange }: { all: string[]; shown: string[]; onChange: (c: string[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!all.length) return null;
  return (
    <div className="relative" ref={ref}>
      <Button variant="secondary" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Columns ({shown.length})
      </Button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          <button className="block w-full px-3 py-1.5 text-left text-xs text-sky-600 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => onChange(null)}>
            Reset to most common
          </button>
          {all.map((k) => (
            <label key={k} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <input
                type="checkbox"
                className="accent-sky-600"
                checked={shown.includes(k)}
                onChange={() => onChange(shown.includes(k) ? shown.filter((x) => x !== k) : [...shown, k])}
              />
              <span className="truncate font-mono text-xs">{k}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
