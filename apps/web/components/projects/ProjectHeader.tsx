"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Project } from "@kitelog/shared";
import { api, ApiError, errMsg } from "@/lib/api";
import { Tabs, tabClass } from "@/components/ui";

/** Loads the project (404/403 handled) and renders its title + tab bar. */
export function useProject(slug: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.project(slug).then(setProject, (e) =>
      setError(e instanceof ApiError && (e.status === 404 || e.status === 403) ? "Project not found or you are not a member." : errMsg(e)),
    );
  }, [slug]);
  return { project, setProject, error };
}

export function ProjectHeader({ project, tab }: { project: Project; tab: "runs" | "settings" }) {
  return (
    <div className="mb-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        {project.description && <p className="mt-1 text-sm text-zinc-500">{project.description}</p>}
      </div>
      <Tabs>
        <Link href={`/projects/${project.slug}`} className={tabClass(tab === "runs")}>
          Runs
        </Link>
        <Link href={`/projects/${project.slug}/settings`} className={tabClass(tab === "settings")}>
          Settings
        </Link>
      </Tabs>
    </div>
  );
}
