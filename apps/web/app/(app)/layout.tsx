import type { ReactNode } from "react";
import { SessionGuard } from "@/components/Session";
import { TopBar } from "@/components/TopBar";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGuard>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </SessionGuard>
  );
}
