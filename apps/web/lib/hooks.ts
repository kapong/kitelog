"use client";
import { useEffect, useRef, useState } from "react";
import type { Role } from "@kitelog/shared";

/** Calls `fn` every `ms` while `active` and the tab is visible. */
export function usePoll(fn: () => unknown, active: boolean, ms = 15_000) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => document.visibilityState === "visible" && ref.current(), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export const atLeast = (role: Role | null, min: Role) => role != null && RANK[role] >= RANK[min];

/** Follows `prefers-color-scheme` (the app's Tailwind `dark:` variant is media-based). */
export function useDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return dark;
}
