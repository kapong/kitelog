"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { ApiKey, ApiKeyCreated, Scope } from "@kitelog/shared";
import { api, errMsg } from "@/lib/api";
import { Button, Card, CodeBlock, ConfirmButton, Dialog, ErrorText, Input, Select, Table, Td, useToast } from "@/components/ui";

const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "—");

export function KeysSettings({ slug }: { slug: string }) {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("write");
  const [error, setError] = useState("");
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  const reload = () => api.keys(slug).then(setKeys, (e) => setError(errMsg(e)));
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      setCreated(await api.createKey(slug, { name, scope }));
      setName("");
      await reload();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  return (
    <Card title="API keys">
      <p className="mb-4 text-sm text-zinc-500">
        Keys let the Python client log to this project. <b>write</b> keys log runs; <b>read</b> keys only read.
      </p>
      {keys === null ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <Table head={["Name", "Key", "Scope", "Created", "Last used", ""]} empty="No API keys yet.">
          {keys.map((k) => (
            <tr key={k.id} className={k.revoked_at ? "opacity-50" : ""}>
              <Td>{k.name}</Td>
              <Td className="font-mono text-xs">{k.prefix}…</Td>
              <Td>{k.scope}</Td>
              <Td className="text-zinc-500">{fmt(k.created_at)}</Td>
              <Td className="text-zinc-500">{fmt(k.last_used_at)}</Td>
              <Td className="text-right">
                {k.revoked_at ? (
                  <span className="text-xs text-zinc-500">revoked</span>
                ) : (
                  <ConfirmButton
                    label="Revoke"
                    variant="ghost"
                    title="Revoke API key?"
                    message={`Scripts using "${k.name}" stop working immediately.`}
                    confirmLabel="Revoke"
                    onConfirm={async () => {
                      try {
                        await api.revokeKey(slug, k.id);
                        await reload();
                        toast("Key revoked");
                      } catch (e) {
                        toast(errMsg(e), "error");
                      }
                    }}
                  />
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <form onSubmit={create} className="mt-5 space-y-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <div className="text-sm font-medium">Create key</div>
        <div className="flex flex-wrap gap-2">
          <Input
            required
            maxLength={128}
            placeholder="Key name, e.g. training-box"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="min-w-48 flex-1"
          />
          <Select className="w-28" value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label="Scope">
            <option value="write">write</option>
            <option value="read">read</option>
          </Select>
          <Button type="submit">Create</Button>
        </div>
        <ErrorText>{error}</ErrorText>
      </form>

      <Dialog open={!!created} onClose={() => setCreated(null)} title="API key created">
        {created && (
          <div className="space-y-4 text-sm">
            <p className="text-amber-700 dark:text-amber-400">Copy this key now. It is shown only once.</p>
            <CodeBlock text={created.key} />
            <p className="text-zinc-600 dark:text-zinc-400">Set it in your shell:</p>
            <CodeBlock text={`export KITELOG_API_KEY=${created.key}\nexport KITELOG_BASE_URL=${origin}`} />
            <p className="text-zinc-600 dark:text-zinc-400">Then from Python:</p>
            <CodeBlock text={`import kitelog as kl\nrun = kl.init(project="${slug}")`} />
            <div className="flex justify-end">
              <Button onClick={() => setCreated(null)}>Done</Button>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
