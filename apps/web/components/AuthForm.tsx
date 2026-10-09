"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, errMsg } from "@/lib/api";
import { safeNextPath } from "@/lib/next-path";
import { Button, ErrorText, Field, Input } from "@/components/ui";

const signupError = (e: unknown) => {
  if (e instanceof ApiError && e.code === "signup_closed") return "An admin account already exists. Log in instead.";
  return errMsg(e);
};

/** Login, or first-admin signup (only offered while the instance has no users). */
export function AuthForm({ mode, heading }: { mode: "login" | "signup"; heading?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== "login") return;
    if (new URLSearchParams(window.location.search).get("reset") === "1") setNotice("Password set. Log in with your new password.");
    api.authStatus().then((s) => setNeedsSetup(s.needs_setup), () => {});
  }, [mode]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") await api.login({ email, password });
      else await api.signup({ email, password, name: name || undefined });
      router.replace(safeNextPath(new URLSearchParams(window.location.search).get("next"), window.location.origin));
    } catch (err) {
      setError(mode === "login" ? errMsg(err) : signupError(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">{heading ?? (mode === "login" ? "Log in" : "Create account")}</h1>
      {notice && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
          {notice}
        </p>
      )}
      {mode === "signup" && (
        <Field label="Name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={128} />
        </Field>
      )}
      <Field label="Email">
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </Field>
      <Field label="Password" hint={mode === "signup" ? "At least 8 characters." : undefined}>
        <Input
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
      </Field>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "…" : mode === "login" ? "Log in" : "Create admin account"}
      </Button>
      {mode === "login" ? (
        needsSetup && (
          <p className="text-center text-sm text-zinc-500">
            No accounts yet?{" "}
            <Link href="/signup" className="text-sky-600 hover:underline">
              Create the admin account
            </Link>
          </p>
        )
      ) : (
        <p className="text-center text-sm text-zinc-500">
          Have an account?{" "}
          <Link href="/login" className="text-sky-600 hover:underline">
            Log in
          </Link>
        </p>
      )}
    </form>
  );
}
