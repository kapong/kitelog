"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cn } from "./cn";

type Toast = { id: number; text: string; kind: "ok" | "error" };
const Ctx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "rounded-md px-4 py-2.5 text-sm shadow-lg",
              t.kind === "ok" ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-red-600 text-white",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
