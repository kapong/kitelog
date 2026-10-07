"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Project, User } from "@kitelog/shared";
import { api, ApiError } from "@/lib/api";

type SessionCtx = { user: User; projects: Project[]; reloadProjects: () => Promise<void> };
const Ctx = createContext<SessionCtx | null>(null);

export function useSession(): SessionCtx {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside <SessionGuard>");
  return s;
}

/** Auth guard: `GET /auth/me`; 401 → /login?next=<path>. Also holds the project list for the switcher. */
export function SessionGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState("");

  const reloadProjects = useCallback(async () => setProjects(await api.projects()), []);

  useEffect(() => {
    api.me().then(
      (u) => {
        setUser(u);
        reloadProjects().catch(() => {});
      },
      (e) => {
        if (e instanceof ApiError && e.status === 401) router.replace(`/login?next=${encodeURIComponent(pathname + window.location.search)}`);
        else setError(e instanceof Error ? e.message : String(e));
      },
    );
    // pathname intentionally omitted: check once per mount, not on every navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, reloadProjects]);

  if (error) return <p className="p-8 text-sm text-red-600">Could not reach the API: {error}</p>;
  if (!user) return <p className="p-8 text-sm text-zinc-500">Loading…</p>;
  return <Ctx.Provider value={{ user, projects, reloadProjects }}>{children}</Ctx.Provider>;
}
