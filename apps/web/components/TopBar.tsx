"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useSession } from "./Session";

export function TopBar() {
  const { user, projects } = useSession();
  const router = useRouter();
  const params = useParams<{ slug?: string }>();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  return (
    <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/90">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link href="/projects" className="font-semibold tracking-tight">
          <span className="text-sky-600">kite</span>log
        </Link>
        <select
          aria-label="Switch project"
          className="h-8 max-w-56 rounded-md border border-zinc-300 bg-transparent px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          value={params.slug ?? ""}
          onChange={(e) => router.push(e.target.value ? `/projects/${e.target.value}` : "/projects")}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        {user.is_admin && (
          <Link href="/admin" className="text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            Admin
          </Link>
        )}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenu((m) => !m)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-600 text-sm font-semibold text-white"
            aria-label="User menu"
            aria-expanded={menu}
          >
            {(user.name || user.email).slice(0, 1).toUpperCase()}
          </button>
          {menu && (
            <div className="absolute right-0 mt-2 w-56 rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
              <div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
                {user.name && <div className="font-medium">{user.name}</div>}
                <div className="truncate text-zinc-500">{user.email}</div>
              </div>
              <Link
                href="/account"
                className="block px-3 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                onClick={() => setMenu(false)}
              >
                Account
              </Link>
              <button
                className="block w-full px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                onClick={async () => {
                  await api.logout().catch(() => {});
                  router.replace("/login");
                }}
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
