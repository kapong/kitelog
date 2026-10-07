"use client";
import { useState } from "react";
import { Button, CodeBlock } from "@/components/ui";

/** Flatten nested objects to dotted keys; arrays and scalars are leaves. */
function flatten(v: unknown, prefix = "", out: [string, unknown][] = []): [string, unknown][] {
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out.push([prefix, v]);
  return out;
}

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** Config / summary as a key-value table (dotted paths), with a raw JSON view. */
export function JsonTable({ value, empty }: { value: Record<string, unknown>; empty: string }) {
  const [raw, setRaw] = useState(false);
  const rows = flatten(value);
  if (!rows.length) return <p className="py-10 text-center text-sm text-zinc-500">{empty}</p>;
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => setRaw((r) => !r)}>
          {raw ? "Table" : "Raw JSON"}
        </Button>
      </div>
      {raw ? (
        <CodeBlock text={JSON.stringify(value, null, 2)} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <td className="w-1/3 px-3 py-2 align-top font-mono text-xs text-zinc-500">{k}</td>
                  <td className="break-all px-3 py-2 font-mono text-xs">{show(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
