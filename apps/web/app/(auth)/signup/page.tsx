"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { AuthStatus } from "@kitelog/shared";
import { api } from "@/lib/api";
import { AuthForm } from "@/components/AuthForm";

// No users yet → the first signup becomes admin. Otherwise signup needs open signup (admin
// setting) or an invite link (/invite/<token>).
export default function SignupPage() {
  const [status, setStatus] = useState<AuthStatus | null | undefined>(undefined);
  useEffect(() => {
    // On error show the normal form; the API still answers `invite_required` if closed.
    api.authStatus().then(setStatus, () => setStatus(null));
  }, []);

  if (status === undefined) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (status?.needs_setup) return <AuthForm mode="signup" heading="Create the admin account" />;
  if (status && !status.open_signup)
    return (
      <div className="space-y-3 text-sm">
        <h1 className="text-lg font-semibold">Signup is invite-only</h1>
        <p className="text-zinc-600 dark:text-zinc-400">Ask an admin for an invite link to create an account.</p>
        <p className="text-zinc-500">
          Have an account?{" "}
          <Link href="/login" className="text-sky-600 hover:underline">
            Log in
          </Link>
        </p>
      </div>
    );
  return <AuthForm mode="signup" />;
}
