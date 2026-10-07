"use client";
import { useParams } from "next/navigation";
import { ProjectHeader, useProject } from "@/components/projects/ProjectHeader";
import { RunsTable } from "@/components/runs/RunsTable";

export default function ProjectPage() {
  const { slug } = useParams<{ slug: string }>();
  const { project, error } = useProject(slug);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!project) return <p className="text-sm text-zinc-500">Loading…</p>;
  return (
    <>
      <ProjectHeader project={project} tab="runs" />
      <RunsTable project={project} />
    </>
  );
}
