"use client";
import { useState, type FormEvent } from "react";
import { api, ApiError, errMsg } from "@/lib/api";
import { useSession } from "@/components/Session";
import { Button, Card, ErrorText, Field, Input, useToast } from "@/components/ui";

export default function AccountPage() {
  const { user } = useSession();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (next !== confirm) return setError("New passwords do not match.");
    setBusy(true);
    try {
      await api.changePassword({ current_password: current, new_password: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("Password changed. Your other sessions were signed out.");
    } catch (err) {
      setError(err instanceof ApiError && err.code === "wrong_password" ? "Current password is incorrect." : errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <Card title="Profile">
        <dl className="grid grid-cols-[6rem_1fr] gap-y-1 text-sm">
          <dt className="text-zinc-500">Email</dt>
          <dd>{user.email}</dd>
          <dt className="text-zinc-500">Name</dt>
          <dd>{user.name ?? "—"}</dd>
        </dl>
      </Card>
      <Card title="Change password">
        <form onSubmit={submit} className="space-y-4">
          <input type="email" value={user.email} autoComplete="username" readOnly hidden />
          <Field label="Current password">
            <Input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 8 characters. Other sessions are signed out.">
            <Input type="password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={busy}>
            {busy ? "…" : "Change password"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
