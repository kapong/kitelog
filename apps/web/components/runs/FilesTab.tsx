"use client";
import { useEffect, useState } from "react";
import type { FileInfo } from "@kitelog/shared";
import { api, errMsg } from "@/lib/api";
import { fmtBytes, fmtTime } from "@/lib/format";
import { Table, Td, cn } from "@/components/ui";

export function FilesTab({ slug, runId }: { slug: string; runId: string }) {
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.runFiles(slug, runId).then(setFiles, (e) => setError(errMsg(e)));
  }, [slug, runId]);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!files) return <p className="text-sm text-zinc-500">Loading…</p>;
  return (
    <Table head={["Path", "Kind", "Size", "Saved", ""]} empty="No files saved for this run.">
      {files.map((f) => (
        <tr key={f.id}>
          <Td className="break-all font-mono text-xs">{f.path}</Td>
          <Td>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-xs font-medium",
                f.kind === "checkpoint"
                  ? "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300"
                  : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
              )}
            >
              {f.kind}
            </span>
          </Td>
          <Td className="whitespace-nowrap tabular-nums">{fmtBytes(f.size)}</Td>
          <Td className="whitespace-nowrap text-zinc-500">{fmtTime(f.created_at)}</Td>
          <Td className="text-right">
            <a href={api.fileDownloadUrl(slug, f.id)} download className="text-sm font-medium text-sky-600 hover:underline">
              Download
            </a>
          </Td>
        </tr>
      ))}
    </Table>
  );
}
