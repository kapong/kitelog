"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import type { Member } from "@kitelog/shared";
import { api, errMsg } from "@/lib/api";
import { ProjectHeader, useProject } from "@/components/projects/ProjectHeader";
import { GeneralSettings } from "@/components/projects/GeneralSettings";
import { MembersSettings } from "@/components/projects/MembersSettings";
import { KeysSettings } from "@/components/projects/KeysSettings";
import { StorageSettings } from "@/components/projects/StorageSettings";
import { cn } from "@/components/ui";
import { atLeast } from "@/lib/hooks";

const SECTIONS = [
  { id: "general", label: "General", min: "viewer" },
  { id: "members", label: "Members", min: "viewer" },
  { id: "keys", label: "API keys", min: "editor" },
  { id: "storage", label: "Storage", min: "owner" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

export default function SettingsPage() {
  const { slug } = useParams<{ slug: string }>();
  const { project, setProject, error } = useProject(slug);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [membersError, setMembersError] = useState("");
  const [section, setSection] = useState<Section>("general");

  const reloadMembers = () => api.members(slug).then(setMembers, (e) => setMembersError(errMsg(e)));
  useEffect(() => {
    reloadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  if (error || membersError) return <p className="text-sm text-red-600">{error || membersError}</p>;
  if (!project || !members) return <p className="text-sm text-zinc-500">Loading…</p>;

  const role = project.role ?? "viewer";
  const visible = SECTIONS.filter((s) => atLeast(role, s.min));

  return (
    <>
      <ProjectHeader project={project} tab="settings" />
      <div className="grid gap-6 md:grid-cols-[180px_1fr]">
        <nav className="flex gap-1 md:flex-col">
          {visible.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              aria-current={section === s.id ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-left text-sm",
                section === s.id
                  ? "bg-zinc-200/70 font-medium dark:bg-zinc-800"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900",
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {section === "general" && <GeneralSettings project={project} isOwner={role === "owner"} onSaved={(p) => setProject({ ...p, role: p.role ?? project.role })} />}
          {section === "members" && (
            <MembersSettings slug={slug} members={members} isOwner={role === "owner"} reload={reloadMembers} />
          )}
          {section === "keys" && <KeysSettings slug={slug} />}
          {section === "storage" && <StorageSettings slug={slug} />}
        </div>
      </div>
    </>
  );
}
