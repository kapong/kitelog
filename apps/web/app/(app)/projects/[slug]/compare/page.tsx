"use client";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import type { RunWithMetrics } from "@kitelog/shared";
import { api, errMsg } from "@/lib/api";
import { useDark, usePoll } from "@/lib/hooks";
import { MetricPanels } from "@/components/charts/MetricPanels";
import { MAX_SERIES, seriesColor } from "@/components/charts/palette";
import { StatusBadge } from "@/components/runs/StatusBadge";

export default function ComparePage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <Compare />
    </Suspense>
  );
}

function Compare() {
  const { slug } = useParams<{ slug: string }>();
  const param = useSearchParams().get("runs") ?? "";
  const ids = useMemo(() => [...new Set(param.split(",").filter(Boolean))].slice(0, MAX_SERIES), [param]);
  const dark = useDark();
  const [runs, setRuns] = useState<RunWithMetrics[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(
    () => Promise.all(ids.map((id) => api.run(slug, id))).then(setRuns, (e) => setError(errMsg(e))),
    [slug, ids],
  );
  useEffect(() => void load(), [load]);
  usePoll(load, !!runs?.some((r) => r.status === "running"));

  const statusKey = runs?.map((r) => r.id + r.name + r.status).join("|");
  const chartRuns = useMemo(() => (runs ?? []).map(({ id, name, status }) => ({ id, name, status })), [statusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = useMemo(() => [...new Set((runs ?? []).flatMap((r) => Object.keys(r.metrics)))], [runs]);

  if (ids.length < 2) return <p className="text-sm text-zinc-500">Select at least two runs to compare.</p>;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!runs) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/projects/${slug}`} className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          ← Runs
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Compare {runs.length} runs</h1>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2" aria-label="Legend">
          {runs.map((r, i) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              <span className="h-0.5 w-5 rounded-full" style={{ background: seriesColor(i, dark), height: 3 }} />
              <Link href={`/projects/${slug}/runs/${r.id}`} className="font-medium hover:underline">
                {r.name}
              </Link>
              <StatusBadge status={r.status} />
            </li>
          ))}
        </ul>
      </div>
      <MetricPanels slug={slug} runs={chartRuns} keys={keys} />
    </div>
  );
}
