"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { Project } from "@kitelog/shared";
import { api, errMsg } from "@/lib/api";
import { useSession } from "@/components/Session";
import { Button, Card, ConfirmButton, ErrorText, Field, Input, useToast } from "@/components/ui";

export function GeneralSettings({ project, isOwner, onSaved }: {
  project: Project;
  isOwner: boolean;
  onSaved: (p: Project) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const { reloadProjects } = useSession();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [error, setError] = useState("");

  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      onSaved(await api.patchProject(project.slug, { name, description }));
      await reloadProjects();
      toast("Project saved");
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <div className="space-y-6">
      <Card title="General">
        <form onSubmit={save} className="space-y-4">
          <Field label="Name">
            <Input required maxLength={128} value={name} disabled={!isOwner} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <Input maxLength={2000} value={description} disabled={!isOwner} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Slug" hint="The slug cannot be changed.">
            <Input value={project.slug} disabled className="font-mono" />
          </Field>
          <ErrorText>{error}</ErrorText>
          {isOwner ? <Button type="submit">Save</Button> : <p className="text-sm text-zinc-500">Only owners can edit the project.</p>}
        </form>
      </Card>
      {isOwner && (
        <Card title="Danger zone">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Delete this project with all its runs, members, and API keys. This cannot be undone.
            </p>
            <ConfirmButton
              label="Delete project"
              title={`Delete ${project.name}?`}
              message="All runs, members, and API keys of this project are removed. This cannot be undone."
              confirmLabel="Delete"
              onConfirm={async () => {
                try {
                  await api.deleteProject(project.slug);
                  await reloadProjects();
                  router.replace("/projects");
                } catch (e) {
                  toast(errMsg(e), "error");
                }
              }}
            />
          </div>
        </Card>
      )}
    </div>
  );
}
