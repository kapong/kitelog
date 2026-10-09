"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { AuthForm } from "@/components/AuthForm";

// Only while there are no users: the first account becomes admin. Admins create every other account.
export default function SignupPage() {
  const router = useRouter();
  const [setup, setSetup] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    api.authStatus().then(
      (s) => (s.needs_setup ? setSetup(true) : router.replace("/login")),
      // API unreachable: show the form; signup answers `signup_closed` if an admin exists.
      () => setSetup(true),
    );
  }, [router]);

  if (!setup) return <p className="text-sm text-zinc-500">Loading…</p>;
  return <AuthForm mode="signup" heading="Create the admin account" />;
}
