"use client";
import { useState, type FormEvent } from "react";
import { Role, type Member } from "@kitelog/shared";
import { api, ApiError, errMsg } from "@/lib/api";
import { useSession } from "@/components/Session";
import { Button, Card, ConfirmButton, ErrorText, Input, Select, Table, Td, useToast } from "@/components/ui";

const ROLES = Role.options;

const memberError = (e: unknown) => {
  if (e instanceof ApiError) {
    if (e.code === "last_owner") return "A project must keep at least one owner.";
    if (e.code === "user_not_found") return "No user with that email — ask an admin to add them.";
    if (e.code === "already_member") return "That user is already a member.";
  }
  return errMsg(e);
};

export function MembersSettings({ slug, members, isOwner, reload }: {
  slug: string;
  members: Member[];
  isOwner: boolean;
  reload: () => Promise<unknown>;
}) {
  const { user } = useSession();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [error, setError] = useState("");

  async function add(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api.addMember(slug, { email, role });
      setEmail("");
      await reload();
      toast("Member added");
    } catch (err) {
      setError(memberError(err));
    }
  }

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await reload();
      toast(ok);
    } catch (e) {
      toast(memberError(e), "error");
    }
  };

  return (
    <Card title="Members">
      <Table head={["Email", "Name", "Role", ""]}>
        {members.map((m) => (
          <tr key={m.user_id}>
            <Td>
              {m.email}
              {m.user_id === user.id && <span className="ml-2 text-xs text-zinc-400">(you)</span>}
            </Td>
            <Td className="text-zinc-500">{m.name ?? "—"}</Td>
            <Td>
              {isOwner ? (
                <Select
                  className="h-8 w-28"
                  value={m.role}
                  aria-label={`Role of ${m.email}`}
                  onChange={(e) => act(() => api.setRole(slug, m.user_id, e.target.value as Role), "Role updated")}
                >
                  {ROLES.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </Select>
              ) : (
                m.role
              )}
            </Td>
            <Td className="text-right">
              {isOwner && (
                <ConfirmButton
                  label="Remove"
                  variant="ghost"
                  title="Remove member?"
                  message={`${m.email} loses access to this project.`}
                  confirmLabel="Remove"
                  onConfirm={() => act(() => api.removeMember(slug, m.user_id), "Member removed")}
                />
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {isOwner && (
        <form onSubmit={add} className="mt-5 space-y-2 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <div className="text-sm font-medium">Add member</div>
          <div className="flex flex-wrap gap-2">
            <Input
              type="email"
              required
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="min-w-48 flex-1"
            />
            <Select className="w-28" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
            <Button type="submit">Add</Button>
          </div>
          <p className="text-xs text-zinc-500">The user must already have an account (admins create accounts).</p>
          <ErrorText>{error}</ErrorText>
        </form>
      )}
    </Card>
  );
}
