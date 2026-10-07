import type { ReactNode } from "react";

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: ReactNode }) {
  const rows = Array.isArray(children) ? children.length : children ? 1 : 0;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
            {head.map((h, i) => (
              <th key={i} className="px-2 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows ? (
            children
          ) : (
            <tr>
              <td colSpan={head.length} className="px-2 py-6 text-center text-zinc-500">
                {empty ?? "Nothing here yet."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={"px-2 py-2.5 align-middle " + (className ?? "")}>{children}</td>;
}
