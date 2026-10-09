"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PasswordResetLookup } from "@kitelog/shared";
import { api, ApiError, errMsg } from "@/lib/api";
import { Button, ErrorText, Field, Input } from "@/components/ui";

const isInvalid = (e: unknown) => e instanceof ApiError && e.code === "invalid_reset";

/** Set-password page for admin-issued links (new account or password reset). */
export default function ResetPage() {
  const router = useRouter();
  // Token arrives in the URL fragment (never sent to a server, never logged); kept in state only.
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<PasswordResetLookup | null | undefined>(undefined);
  const [loadError, setLoadError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const read = useRef(false); // StrictMode runs effects twice; the hash is gone the second time.
  useEffect(() => {
    if (read.current) return;
    read.current = true;
    const t = window.location.hash.slice(1);
    history.replaceState(null, "", "/reset");
    if (!t) return setInfo(null);
    setToken(t);
    api.resetLookup(t).then(setInfo, (e) => (isInvalid(e) ? setInfo(null) : setLoadError(errMsg(e))));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    try {
      await api.resetPassword({ token, new_password: password });
      router.replace("/login?reset=1");
    } catch (err) {
      if (isInvalid(err)) setInfo(null);
      else setError(errMsg(err));
      setBusy(false);
    }
  }

  if (loadError) return <ErrorText>{loadError}</ErrorText>;
  if (info === undefined) return <p className="text-sm text-zinc-500">Checking link…</p>;
  if (info === null)
    return (
      <div className="space-y-3 text-sm">
        <h1 className="text-lg font-semibold">Link not valid</h1>
        <p className="text-zinc-600 dark:text-zinc-400">This link is invalid or expired. Ask an admin for a new one.</p>
        <Link href="/login" className="text-sky-600 hover:underline">
          Go to log in
        </Link>
      </div>
    );
  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">Set your password</h1>
      <Field label="Email">
        <Input type="email" value={info.email} readOnly autoComplete="username" />
      </Field>
      <Field label="New password" hint="At least 8 characters.">
        <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="Confirm password">
        <Input type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Field>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "…" : "Set password"}
      </Button>
    </form>
  );
}
