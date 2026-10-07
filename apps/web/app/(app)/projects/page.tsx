"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, errMsg } from "@/lib/api";
import { useSession } from "@/components/Session";
import { Button, Card, Dialog, ErrorText, Field, Input } from "@/components/ui";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);

export default function ProjectsPage() {
  const { projects, reloadProjects } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const p = await api.createProject({ name, slug, description: description || undefined });
      await reloadProjects();
      router.push(`/projects/${p.slug}`);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <Button onClick={() => setOpen(true)}>New project</Button>
      </div>

      {projects.length === 0 ? (
        <Card>
          <p className="text-sm text-zinc-500">No projects yet. Create one to start logging runs.</p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/projects/${p.slug}`}
              className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-sky-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-sky-600"
            >
              <div className="font-medium">{p.name}</div>
              <div className="font-mono text-xs text-zinc-500">{p.slug}</div>
              {p.description && <p className="mt-2 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">{p.description}</p>}
              <div className="mt-3 text-xs text-zinc-400">Created {new Date(p.created_at).toLocaleDateString()}</div>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title="New project">
        <form onSubmit={create} className="space-y-4">
          <Field label="Name">
            <Input
              required
              autoFocus
              maxLength={128}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) setSlug(slugify(e.target.value));
              }}
            />
          </Field>
          <Field label="Slug" hint="Lowercase letters, digits, and dashes. Used in URLs and by the Python client.">
            <Input
              required
              pattern="[a-z0-9][a-z0-9\-]{0,62}"
              value={slug}
              className="font-mono"
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
            />
          </Field>
          <Field label="Description (optional)">
            <Input maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
