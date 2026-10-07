"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunStatus } from "@kitelog/shared";
import { api, errMsg } from "@/lib/api";
import { useDark, usePoll } from "@/lib/hooks";
import { Input, cn } from "@/components/ui";
import { LineChart, type Line } from "./LineChart";
import { seriesColor } from "./palette";

export type ChartRun = { id: string; name: string; status: RunStatus };
type Series = { step: number[]; value: number[] };
const BATCH = 20; // keys per metrics request (and per lazily loaded block of panels)
const EMPTY: Series = { step: [], value: [] };

/**
 * Loads series per (run, key) on demand, `BATCH` keys per request. Every 15 s refetches the
 * visible requested keys of running runs, skipping a run whose previous fetch is still in
 * flight. Keys whose fetch failed are forgotten so the next `ensure` retries them.
 */
function useSeries(slug: string, runs: ChartRun[]) {
  const [data, setData] = useState<Record<string, Record<string, Series>>>({});
  const [error, setError] = useState("");
  const requested = useRef(new Map<string, Set<string>>());
  const inFlight = useRef(new Map<string, number>()); // run id -> fetches in progress
  const visible = useRef(new Map<string, number>()); // key -> visible blocks showing it

  const fetchKeys = useCallback(
    async (runId: string, keys: string[]) => {
      inFlight.current.set(runId, (inFlight.current.get(runId) ?? 0) + 1);
      try {
        for (let i = 0; i < keys.length; i += BATCH) {
          const batch = keys.slice(i, i + BATCH);
          try {
            const { series } = await api.runMetrics(slug, runId, batch);
            setData((d) => {
              const next = { ...d[runId] };
              for (const k of batch) next[k] = series[k] ?? EMPTY;
              return { ...d, [runId]: next };
            });
          } catch (e) {
            const have = requested.current.get(runId);
            batch.forEach((k) => have?.delete(k)); // retried by the next ensure()
            setError(errMsg(e));
          }
        }
      } finally {
        const n = (inFlight.current.get(runId) ?? 1) - 1;
        if (n > 0) inFlight.current.set(runId, n);
        else inFlight.current.delete(runId);
      }
    },
    [slug],
  );

  const ensure = useCallback(
    (keys: string[]) => {
      for (const r of runs) {
        const have = requested.current.get(r.id) ?? new Set<string>();
        requested.current.set(r.id, have);
        const missing = keys.filter((k) => !have.has(k));
        missing.forEach((k) => have.add(k));
        if (missing.length) void fetchKeys(r.id, missing);
      }
    },
    [runs, fetchKeys],
  );

  /** Block visibility: visible keys are polled; becoming visible loads missing keys. */
  const setVisible = useCallback(
    (keys: string[], on: boolean) => {
      for (const k of keys) {
        const n = (visible.current.get(k) ?? 0) + (on ? 1 : -1);
        if (n > 0) visible.current.set(k, n);
        else visible.current.delete(k);
      }
      if (on) ensure(keys);
    },
    [ensure],
  );

  /** Refetch requested keys of `ids` (only visible ones unless `all`), skipping busy runs. */
  const refetch = useCallback(
    (ids: string[], all = false) => {
      for (const id of ids) {
        if (!all && inFlight.current.has(id)) continue;
        const keys = [...(requested.current.get(id) ?? [])].filter((k) => all || visible.current.has(k));
        if (keys.length) void fetchKeys(id, keys);
      }
    },
    [fetchKeys],
  );
  const running = runs.filter((r) => r.status === "running").map((r) => r.id);
  usePoll(() => {
    ensure([...visible.current.keys()]); // retry visible keys whose fetch failed
    refetch(running);
  }, running.length > 0);
  // A run that just stopped running: one last fetch of all its keys for the final flush.
  const wasRunning = useRef<string[]>([]);
  const runningKey = running.join(",");
  useEffect(() => {
    const now = runningKey ? runningKey.split(",") : [];
    refetch(wasRunning.current.filter((id) => !now.includes(id)), true);
    wasRunning.current = now;
  }, [runningKey, refetch]);

  return { data, setVisible, error };
}

const groupOf = (k: string) => (k.includes("/") ? k.slice(0, k.indexOf("/")) : "");

/** Charts for `keys` across `runs` (one color per run), grouped by key prefix. */
export function MetricPanels({ slug, runs, keys }: { slug: string; runs: ChartRun[]; keys: string[] }) {
  const dark = useDark();
  const smooth = useThrottled(0, 50);
  const smoothing = smooth.committed;
  const [log, setLog] = useState(false);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { data, setVisible, error } = useSeries(slug, runs);

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const by = new Map<string, string[]>();
    for (const k of [...keys].sort()) {
      if (f && !k.toLowerCase().includes(f)) continue;
      const g = groupOf(k);
      by.set(g, [...(by.get(g) ?? []), k]);
    }
    // Prefixed groups alphabetically, un-prefixed keys last.
    return [...by].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  }, [keys, filter]);

  const toggle = (g: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });

  if (!keys.length) return <p className="py-10 text-center text-sm text-zinc-500">No metrics logged yet.</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <div className="w-56">
          <Input className="h-8" placeholder="Filter metrics" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter metrics" />
        </div>
        <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
          Smoothing
          <input
            type="range"
            min={0}
            max={0.99}
            step={0.01}
            value={smooth.value}
            onChange={(e) => smooth.set(Number(e.target.value))}
            className="w-32 accent-sky-600"
          />
          <span className="w-8 tabular-nums text-zinc-900 dark:text-zinc-100">{smooth.value.toFixed(2)}</span>
        </label>
        <label className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} className="accent-sky-600" />
          Log scale
        </label>
        <span className="text-xs text-zinc-500">Drag to zoom · double-click to reset</span>
      </div>
      {error && <p className="text-sm text-red-600">Some metrics failed to load: {error}</p>}
      {groups.map(([g, ks]) => (
        <section key={g || "_"}>
          <button
            onClick={() => toggle(g)}
            className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-zinc-800 dark:text-zinc-200"
            aria-expanded={!collapsed.has(g)}
          >
            <span className={cn("inline-block text-xs text-zinc-400 transition-transform", !collapsed.has(g) && "rotate-90")}>▶</span>
            {g || "Other"}
            <span className="font-normal text-zinc-500">({ks.length})</span>
          </button>
          {!collapsed.has(g) &&
            chunks(ks).map((chunk) => (
              <LazyBlock key={chunk[0]} keys={chunk} onVisibility={setVisible}>
                {chunk.map((k) => (
                  <Panel key={k} k={k} group={g} runs={runs} data={data} smoothing={smoothing} log={log} dark={dark} />
                ))}
              </LazyBlock>
            ))}
        </section>
      ))}
    </div>
  );
}

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += BATCH) out.push(xs.slice(i, i + BATCH));
  return out;
}

/**
 * Input state that updates `value` on every change but commits to `committed` at most once
 * per `ms` (trailing, on an animation frame), so heavy consumers do not re-render per event.
 */
function useThrottled(initial: number, ms: number) {
  const [value, setValue] = useState(initial);
  const [committed, setCommitted] = useState(initial);
  const pending = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef(0);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      cancelAnimationFrame(frame.current);
    },
    [],
  );
  const set = useCallback(
    (v: number) => {
      setValue(v);
      pending.current = v;
      if (timer.current) return;
      timer.current = setTimeout(() => {
        frame.current = requestAnimationFrame(() => {
          timer.current = null;
          setCommitted(pending.current);
        });
      }, ms);
    },
    [ms],
  );
  return { value, committed, set };
}

/** Grid block that reports when it enters / leaves the viewport (with a 300px margin). */
function LazyBlock({ keys, onVisibility, children }: {
  keys: string[];
  onVisibility: (keys: string[], visible: boolean) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisibility);
  cb.current = onVisibility;
  const id = keys.join(",");
  useEffect(() => {
    const ks = id.split(",");
    let shown = false;
    const io = new IntersectionObserver(
      (es) => {
        const now = es[es.length - 1].isIntersecting;
        if (now === shown) return;
        shown = now;
        cb.current(ks, now);
      },
      { rootMargin: "300px" },
    );
    io.observe(ref.current!);
    return () => {
      io.disconnect();
      if (shown) cb.current(ks, false);
    };
  }, [id]); // re-arm when the block's keys change (new keys logged)
  return (
    <div ref={ref} className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {children}
    </div>
  );
}

function Panel({ k, group, runs, data, smoothing, log, dark }: {
  k: string;
  group: string;
  runs: ChartRun[];
  data: Record<string, Record<string, Series>>;
  smoothing: number;
  log: boolean;
  dark: boolean;
}) {
  const loaded = runs.every((r) => data[r.id]?.[k]);
  const lines = useMemo<Line[]>(
    () =>
      runs.flatMap((r, i) => {
        const s = data[r.id]?.[k];
        return s && s.step.length ? [{ label: r.name, color: seriesColor(i, dark), step: s.step, value: s.value }] : [];
      }),
    // Recompute only when this key's series objects change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runs, dark, ...runs.map((r) => data[r.id]?.[k])],
  );
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-1 truncate text-sm font-medium" title={k}>
        {group && <span className="text-zinc-500">{group}/</span>}
        {group ? k.slice(group.length + 1) : k}
      </h3>
      {lines.length ? (
        <LineChart lines={lines} smoothing={smoothing} log={log} dark={dark} />
      ) : (
        <div className="flex h-[200px] items-center justify-center text-xs text-zinc-500">{loaded ? "No data" : "Loading…"}</div>
      )}
    </div>
  );
}
