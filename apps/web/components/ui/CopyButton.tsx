"use client";
import { useState } from "react";
import { Button } from "./Button";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

/** Monospace block with a copy button. */
export function CodeBlock({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-zinc-100 p-3 pr-20 font-mono text-xs text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
        {text}
      </pre>
      <div className="absolute right-2 top-2">
        <CopyButton text={text} />
      </div>
    </div>
  );
}
