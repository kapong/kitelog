"use client";
import { useEffect, useState, type FormEvent } from "react";
import { StorageConfigInput, type StorageConfig } from "@kitelog/shared";
import { api, ApiError, errMsg } from "@/lib/api";
import { Button, Card, ConfirmButton, ErrorText, Field, Input, useToast } from "@/components/ui";

const EMPTY = { endpoint: "", region: "auto", bucket: "", prefix: "", access_key_id: "", secret_access_key: "", path_style: false };

const storageError = (e: unknown) =>
  e instanceof ApiError && e.code === "storage_probe_failed"
    ? `Probe failed at step "${String(e.details.step ?? "?")}": ${e.message}`
    : errMsg(e);

export function StorageSettings({ slug }: { slug: string }) {
  const toast = useToast();
  const [config, setConfig] = useState<StorageConfig | null | undefined>(undefined);
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [testOk, setTestOk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.storage(slug).then(setConfig, (e) => setError(errMsg(e)));
  }, [slug]);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setTestOk(false);
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  };

  /** Validate locally with the shared schema first, so mistakes show without a round trip. */
  function parsed() {
    const r = StorageConfigInput.safeParse(form);
    if (!r.success) {
      const i = r.error.issues[0]!;
      setError(`${i.path.join(".")}: ${i.message}`);
      return null;
    }
    return r.data;
  }

  async function run(fn: (cfg: StorageConfigInput) => Promise<void>) {
    setError("");
    const cfg = parsed();
    if (!cfg) return;
    setBusy(true);
    try {
      await fn(cfg);
    } catch (e) {
      setError(storageError(e));
    } finally {
      setBusy(false);
    }
  }

  const test = () =>
    run(async (cfg) => {
      await api.testStorage(slug, cfg);
      setTestOk(true);
    });

  const save = (e: FormEvent) => {
    e.preventDefault();
    return run(async (cfg) => {
      setConfig(await api.saveStorage(slug, cfg));
      setEditing(false);
      setForm(EMPTY);
      toast("Storage saved");
    });
  };

  if (config === undefined) return <Card title="Storage">{error ? <ErrorText>{error}</ErrorText> : <p className="text-sm text-zinc-500">Loading…</p>}</Card>;

  return (
    <div className="space-y-6">
      <Card title="Storage">
        {config ? (
          <div className="space-y-3 text-sm">
            <div>
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                Own S3
              </span>
              <span className="ml-2 text-zinc-500">Metrics, checkpoints, and artifacts. No quota.</span>
            </div>
            <dl className="grid grid-cols-[140px_1fr] gap-y-1">
              <dt className="text-zinc-500">Endpoint</dt>
              <dd className="font-mono text-xs break-all">{config.endpoint}</dd>
              <dt className="text-zinc-500">Region</dt>
              <dd>{config.region}</dd>
              <dt className="text-zinc-500">Bucket</dt>
              <dd className="font-mono text-xs">{config.bucket}</dd>
              <dt className="text-zinc-500">Prefix</dt>
              <dd className="font-mono text-xs">{config.prefix || "—"}</dd>
              <dt className="text-zinc-500">Access key</dt>
              <dd className="font-mono text-xs">{config.access_key_prefix}…</dd>
              <dt className="text-zinc-500">Path-style</dt>
              <dd>{config.path_style ? "yes" : "no"}</dd>
              <dt className="text-zinc-500">Updated</dt>
              <dd>{new Date(config.updated_at).toLocaleString()}</dd>
            </dl>
            <div className="flex gap-2 pt-2">
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Replace config
              </Button>
              <ConfirmButton
                label="Remove"
                size="md"
                title="Remove S3 config?"
                message="The project falls back to built-in storage (checkpoints only, 100 MB). Existing data in your bucket is not migrated."
                confirmLabel="Remove"
                onConfirm={async () => {
                  try {
                    await api.removeStorage(slug);
                    setConfig(null);
                    toast("Storage config removed");
                  } catch (e) {
                    toast(errMsg(e), "error");
                  }
                }}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div>
              <span className="rounded bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                Built-in
              </span>
              <span className="ml-2 text-zinc-500">Limited: checkpoints only, 100 MB, latest kept.</span>
            </div>
            <p className="text-zinc-500">Connect your own S3-compatible bucket (AWS, R2, MinIO, RustFS) to store artifacts and remove the limits.</p>
            {!editing && <Button onClick={() => setEditing(true)}>Use own S3</Button>}
          </div>
        )}
      </Card>

      {editing && (
        <Card title="S3-compatible storage">
          <form onSubmit={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Endpoint" hint="https (public hostname)">
                <Input required placeholder="https://s3.example.com" value={form.endpoint} onChange={set("endpoint")} />
              </Field>
              <Field label="Region">
                <Input required value={form.region} onChange={set("region")} />
              </Field>
              <Field label="Bucket">
                <Input required value={form.bucket} onChange={set("bucket")} />
              </Field>
              <Field label="Prefix (optional)">
                <Input value={form.prefix} onChange={set("prefix")} />
              </Field>
              <Field label="Access key ID">
                <Input required autoComplete="off" value={form.access_key_id} onChange={set("access_key_id")} />
              </Field>
              <Field label="Secret access key" hint="Encrypted at rest; never shown again.">
                <Input required type="password" autoComplete="new-password" value={form.secret_access_key} onChange={set("secret_access_key")} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.path_style} onChange={set("path_style")} className="h-4 w-4 accent-sky-600" />
              Path-style addressing (MinIO, RustFS)
            </label>
            <p className="text-xs text-zinc-500">Changing storage does not migrate existing data.</p>
            <ErrorText>{error}</ErrorText>
            {testOk && (
              <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                Connection OK: put, get, and delete succeeded.
              </p>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" disabled={busy} onClick={test}>
                Test
              </Button>
              <Button type="submit" disabled={busy}>
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setError("");
                  setForm(EMPTY);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
