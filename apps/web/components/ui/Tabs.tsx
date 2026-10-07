import type { ReactNode } from "react";
import { cn } from "./cn";

export function Tabs({ children }: { children: ReactNode }) {
  return <nav className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">{children}</nav>;
}

export const tabClass = (active: boolean) =>
  cn(
    "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
    active
      ? "border-sky-600 text-zinc-900 dark:text-zinc-100"
      : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200",
  );
