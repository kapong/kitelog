"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { AdminUser, PasswordResetCreated } from "@kitelog/shared";
import { api, ApiError, errMsg } from "@/lib/api";
import { useSession } from "@/components/Session";
import { Button, Card, CodeBlock, ConfirmButton, Dialog, ErrorText, Field, Input, Table, Td, useToast } from "@/components/ui";

const adminError = (e: unknown) => {
  if (e instanceof ApiError) {
    if (e.code === "last_admin") return "There must always be at least one admin. Promote someone else first.";
    if (e.code === "last_owner") return "This user is the only owner of a project. Make someone else owner of that project first.";
    if (e.code === "email_taken") return "A user with that email already exists.";
  }
  return errMsg(e);
};

/** One-time link the user opens to set a password. */
type Link = { email: string; url: string; valid: string; isNew: boolean };
const linkOf = (email: string, r: PasswordResetCreated, isNew: boolean): Link => ({
  email,
  url: `${window.location.origin}/reset#${r.token}`,
  valid: isNew ? "7 days" : "24 hours",
  isNew,
});

export default function AdminPage() {
  const { user } = useSession();
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<Link | null>(null);

  const reload = () => api.users().then(setUsers, (e) => setError(errMsg(e)));
  useEffect(() => {
    if (user.is_admin) reload();
  }, [user.is_admin]);

  if (!user.is_admin) return <p className="text-sm text-zinc-500">Admins only.</p>;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await reload();
      toast(ok);
    } catch (e) {
      toast(adminError(e), "error");
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>

      <Card title="Users" actions={<Button size="sm" onClick={() => setAdding(true)}>Add user</Button>}>
        <ErrorText>{error}</ErrorText>
        {users === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <Table head={["Email", "Name", "Role", "Created", ""]} empty="No users.">
            {users.map((u) => {
              const self = u.id === user.id;
              return (
                <tr key={u.id}>
                  <Td>
                    {u.email}
                    {self && <span className="ml-2 text-xs text-zinc-400">(you)</span>}
                  </Td>
                  <Td className="text-zinc-500">{u.name ?? "—"}</Td>
                  <Td>
                    {u.is_admin ? (
                      <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                        admin
                      </span>
                    ) : (
                      <span className="text-zinc-500">user</span>
                    )}
                  </Td>
                  <Td className="text-zinc-500">{new Date(u.created_at).toLocaleDateString()}</Td>
                  <Td className="whitespace-nowrap text-right">
                    <div className="flex justify-end gap-1">
                      {!(self && u.is_admin) && (
                        <ConfirmButton
                          label={u.is_admin ? "Remove admin" : "Make admin"}
                          variant="ghost"
                          title={u.is_admin ? "Remove admin?" : "Make admin?"}
                          message={
                            u.is_admin
                              ? `${u.email} becomes a regular user and loses access to the admin page.`
                              : `${u.email} becomes an admin: they can manage all users, reset passwords, and delete accounts.`
                          }
                          confirmLabel={u.is_admin ? "Remove admin" : "Make admin"}
                          onConfirm={() =>
                            act(() => api.patchUser(u.id, { is_admin: !u.is_admin }), u.is_admin ? "Admin removed" : "Made admin")
                          }
                        />
                      )}
                      <ConfirmButton
                        label="Reset password"
                        variant="ghost"
                        title="Reset password?"
                        message={`Creates a new set-password link for ${u.email} (valid 24 hours). Older unused links stop working. The current password keeps working until the link is used.`}
                        confirmLabel="Create link"
                        onConfirm={async () => {
                          try {
                            setLink(linkOf(u.email, await api.resetUser(u.id), false));
                          } catch (e) {
                            toast(adminError(e), "error");
                          }
                        }}
                      />
                      {!self && (
                        <ConfirmButton
                          label="Delete"
                          variant="ghost"
                          title="Delete user?"
                          message={`${u.email} is deleted with their sessions and project memberships. This cannot be undone.`}
                          confirmLabel="Delete"
                          onConfirm={() => act(() => api.deleteUser(u.id), "User deleted")}
                        />
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <AddUserDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={async (l) => {
          setAdding(false);
          setLink(l);
          await reload();
        }}
      />

      <Dialog open={!!link} onClose={() => setLink(null)} title={link?.isNew ? "User created" : "Password reset link"}>
        {link && (
          <div className="space-y-3 text-sm">
            <p>
              Send this link to <span className="font-medium">{link.email}</span> to set a password. It is shown only
              once, works once, and is valid {link.valid}.
            </p>
            <CodeBlock text={link.url} />
            <div className="flex justify-end">
              <Button onClick={() => setLink(null)}>Done</Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function AddUserDialog({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (link: Link) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setName("");
    setIsAdmin(false);
    setError("");
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const created = await api.createUser({ email, name: name || undefined, is_admin: isAdmin });
      await onCreated(linkOf(created.user.email, created.reset, true));
    } catch (err) {
      setError(adminError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} locked={busy} title="Add user">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-sky-600" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          Admin
        </label>
        <p className="text-xs text-zinc-500">You get a one-time link (valid 7 days) for the user to set their password.</p>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "…" : "Create user"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
