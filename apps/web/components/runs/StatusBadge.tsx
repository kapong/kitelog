import type { RunStatus } from "@kitelog/shared";
import { cn } from "@/components/ui";

const styles: Record<RunStatus, string> = {
  running: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-950/60 dark:text-sky-300 dark:ring-sky-400/30",
  finished: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-400/30",
  failed: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-950/60 dark:text-red-300 dark:ring-red-400/30",
  crashed: "bg-amber-50 text-amber-800 ring-amber-600/30 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-400/30",
};
const dot: Record<RunStatus, string> = {
  running: "bg-sky-500 animate-pulse",
  finished: "bg-emerald-500",
  failed: "bg-red-500",
  crashed: "bg-amber-500",
};

/** Status as dot + label (never color alone); running pulses. */
export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", styles[status])}>
      <span className={cn("h-1.5 w-1.5 rounded-full", dot[status])} />
      {status}
    </span>
  );
}

export function Tag({ children }: { children: string }) {
  return (
    <span className="inline-block rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      {children}
    </span>
  );
}
