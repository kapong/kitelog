"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, errMsg } from "@/lib/api";
import { safeNextPath } from "@/lib/next-path";
import { Button, ErrorText, Field, Input } from "@/components/ui";

const signupError = (e: unknown) => {
  if (e instanceof ApiError) {
    if (e.code === "invite_required") return "Signup is invite-only. Ask an admin for an invite link.";
    if (e.code === "invalid_invite") return "This invite is invalid, already used, or expired.";
    if (e.code === "email_taken") return "That email is already registered. Log in instead.";
  }
  return errMsg(e);
};

export function AuthForm({ mode, inviteToken, inviteEmail, heading }: {
  mode: "login" | "signup";
  heading?: string;
  inviteToken?: string;
  inviteEmail?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(inviteEmail ?? "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") await api.login({ email, password });
      else await api.signup({ email, password, name: name || undefined, invite_token: inviteToken });
      router.replace(safeNextPath(new URLSearchParams(window.location.search).get("next"), window.location.origin));
    } catch (err) {
      setError(mode === "login" ? errMsg(err) : signupError(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">
        {heading ?? (mode === "login" ? "Log in" : inviteToken ? "Accept invite" : "Create account")}
      </h1>
      {mode === "signup" && (
        <Field label="Name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={128} />
        </Field>
      )}
      <Field label="Email">
        <Input
          type="email"
          required
          value={email}
          readOnly={!!inviteEmail}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
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
        {busy ? "…" : mode === "login" ? "Log in" : "Sign up"}
      </Button>
      <p className="text-center text-sm text-zinc-500">
        {mode === "login" ? (
          <>
            No account?{" "}
            <Link href="/signup" className="text-sky-600 hover:underline">
              Sign up
            </Link>
          </>
        ) : (
          <>
            Have an account?{" "}
            <Link href="/login" className="text-sky-600 hover:underline">
              Log in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
