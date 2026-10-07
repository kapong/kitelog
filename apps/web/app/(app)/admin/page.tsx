"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { Invite, Settings } from "@kitelog/shared";
import { api, errMsg } from "@/lib/api";
import { useSession } from "@/components/Session";
import { Button, Card, CodeBlock, ConfirmButton, ErrorText, Input, Table, Td, useToast } from "@/components/ui";

function inviteStatus(i: Invite) {
  if (i.used_at) return "used";
  return i.expires_at < Date.now() ? "expired" : "pending";
}

export default function AdminPage() {
  const { user } = useSession();
  const toast = useToast();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [error, setError] = useState("");

  const reload = () => api.invites().then(setInvites, (e) => setError(errMsg(e)));
  useEffect(() => {
    if (!user.is_admin) return;
    reload();
    api.settings().then(setSettings, (e) => setError(errMsg(e)));
  }, [user.is_admin]);

  if (!user.is_admin) return <p className="text-sm text-zinc-500">Admins only.</p>;

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const created = await api.createInvite(email);
      setLink(`${window.location.origin}/invite/${created.token}`);
      setEmail("");
      await reload();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>

      <Card title="Signup">
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-sky-600"
            checked={settings?.open_signup ?? false}
            disabled={!settings}
            onChange={async (e) => {
              try {
                setSettings(await api.patchSettings({ open_signup: e.target.checked }));
                toast("Settings saved");
              } catch (err) {
                toast(errMsg(err), "error");
              }
            }}
          />
          <span>
            <span className="font-medium">Open signup</span>
            <span className="block text-zinc-500">Anyone can create an account without an invite.</span>
          </span>
        </label>
      </Card>

      <Card title="Invites">
        <form onSubmit={invite} className="mb-4 flex flex-wrap gap-2">
          <Input
            type="email"
            required
            placeholder="new.user@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-w-48 flex-1"
          />
          <Button type="submit">Create invite</Button>
        </form>
        <ErrorText>{error}</ErrorText>
        {link && (
          <div className="mb-4 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
            <p>Send this link to the invitee. It is shown only once and expires in 7 days.</p>
            <CodeBlock text={link} />
            <Button variant="ghost" size="sm" onClick={() => setLink("")}>
              Dismiss
            </Button>
          </div>
        )}
        {invites === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <Table head={["Email", "Status", "Expires", ""]} empty="No invites.">
            {invites.map((i) => (
              <tr key={i.id}>
                <Td>{i.email}</Td>
                <Td>{inviteStatus(i)}</Td>
                <Td className="text-zinc-500">{new Date(i.expires_at).toLocaleString()}</Td>
                <Td className="text-right">
                  <ConfirmButton
                    label={i.used_at ? "Delete" : "Revoke"}
                    variant="ghost"
                    title="Revoke invite?"
                    message={`The invite link for ${i.email} stops working.`}
                    confirmLabel="Revoke"
                    onConfirm={async () => {
                      try {
                        await api.revokeInvite(i.id);
                        await reload();
                        toast("Invite revoked");
                      } catch (e) {
                        toast(errMsg(e), "error");
                      }
                    }}
                  />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
