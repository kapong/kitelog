"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { RunWithMetrics } from "@kitelog/shared";
import { api, ApiError, errMsg } from "@/lib/api";
import { fmtDuration, fmtTime, runDuration } from "@/lib/format";
import { atLeast, usePoll } from "@/lib/hooks";
import { useProject } from "@/components/projects/ProjectHeader";
import { ConfirmButton, Tabs, tabClass, useToast } from "@/components/ui";
import { StatusBadge, Tag } from "@/components/runs/StatusBadge";
import { JsonTable } from "@/components/runs/JsonTable";
import { FilesTab } from "@/components/runs/FilesTab";
import { MetricPanels } from "@/components/charts/MetricPanels";

const TABS = ["charts", "config", "summary", "files"] as const;
type Tab = (typeof TABS)[number];

export default function RunPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const router = useRouter();
  const toast = useToast();
  const role = useProject(slug).project?.role ?? null; // caller's role from GET /projects/:slug
  const [run, setRun] = useState<RunWithMetrics | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("charts");

  const load = useCallback(
    () =>
      api.run(slug, id).then(setRun, (e) =>
        setError(e instanceof ApiError && e.status === 404 ? "Run not found." : errMsg(e)),
      ),
    [slug, id],
  );
  useEffect(() => void load(), [load]);
  usePoll(load, run?.status === "running");

  const keys = useMemo(() => Object.keys(run?.metrics ?? {}), [run?.metrics]);
  const chartRuns = useMemo(() => (run ? [{ id: run.id, name: run.name, status: run.status }] : []), [run?.id, run?.name, run?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!run) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/projects/${slug}`} className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          ← Runs
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{run.name}</h1>
          <StatusBadge status={run.status} />
          <div className="flex-1" />
          {atLeast(role, "editor") && (
            <ConfirmButton
              label="Delete run"
              title="Delete run?"
              message={
                <>
                  This permanently deletes <b>{run.name}</b>, its metrics and its files.
                </>
              }
              confirmLabel="Delete"
              onConfirm={async () => {
                try {
                  await api.deleteRun(slug, run.id);
                  toast("Run deleted");
                  router.push(`/projects/${slug}`);
                } catch (e) {
                  toast(errMsg(e), "error");
                }
              }}
            />
          )}
        </div>
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-500">
          <div>
            <dt className="inline">Created </dt>
            <dd className="inline text-zinc-800 dark:text-zinc-200">{fmtTime(run.created_at)}</dd>
          </div>
          {run.finished_at && (
            <div>
              <dt className="inline">Finished </dt>
              <dd className="inline text-zinc-800 dark:text-zinc-200">{fmtTime(run.finished_at)}</dd>
            </div>
          )}
          <div>
            <dt className="inline">Duration </dt>
            <dd className="inline tabular-nums text-zinc-800 dark:text-zinc-200">{fmtDuration(runDuration(run))}</dd>
          </div>
          <div>
            <dt className="inline">ID </dt>
            <dd className="inline font-mono text-xs text-zinc-800 dark:text-zinc-200">{run.id}</dd>
          </div>
        </dl>
        {run.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {run.tags.map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
          </div>
        )}
      </div>

      <Tabs>
        {TABS.map((t) => (
          <button key={t} className={tabClass(tab === t)} onClick={() => setTab(t)} aria-current={tab === t ? "page" : undefined}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </Tabs>

      {tab === "charts" && <MetricPanels slug={slug} runs={chartRuns} keys={keys} />}
      {tab === "config" && <JsonTable value={run.config} empty="No config logged." />}
      {tab === "summary" && <JsonTable value={run.summary} empty="No summary logged." />}
      {tab === "files" && <FilesTab slug={slug} runId={run.id} />}
    </div>
  );
}
