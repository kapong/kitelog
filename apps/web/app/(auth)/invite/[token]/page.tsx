"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { InviteLookup } from "@kitelog/shared";
import { api, ApiError } from "@/lib/api";
import { AuthForm } from "@/components/AuthForm";

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<{ invite?: InviteLookup; invalid?: boolean; done?: boolean }>({});

  useEffect(() => {
    api.inviteLookup(token).then(
      (invite) => setState({ invite, done: true }),
      // 404 = invalid/used/expired. Other errors: still let the user try with a typed email.
      (e) => setState({ invalid: e instanceof ApiError && e.status === 404, done: true }),
    );
  }, [token]);

  if (!state.done) return <p className="text-sm text-zinc-500">Checking invite…</p>;
  if (state.invalid)
    return (
      <div className="space-y-3 text-sm">
        <h1 className="text-lg font-semibold">Invite not valid</h1>
        <p className="text-zinc-600 dark:text-zinc-400">This invite link is invalid, already used, or expired. Ask an admin for a new one.</p>
        <Link href="/login" className="text-sky-600 hover:underline">
          Go to log in
        </Link>
      </div>
    );
  return <AuthForm mode="signup" inviteToken={token} inviteEmail={state.invite?.email} />;
}
