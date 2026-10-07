"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";

/**
 * Native modal `<dialog>`: focus trap, inert background and Escape come from `showModal()`.
 * Backdrop click closes. `locked` (e.g. while a request runs) ignores Escape and backdrop.
 */
export function Dialog({ open, onClose, title, locked = false, children }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  locked?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault(); // parent owns `open`
        if (!locked) onClose();
      }}
      // Browser force-close (e.g. repeated Escape skips `cancel`): keep parent state in sync.
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(e) => e.target === ref.current && !locked && onClose()}
      className="m-auto w-full max-w-md rounded-lg border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
    >
      {open && (
        <div className="p-5">
          <h2 id={titleId} className="mb-3 text-base font-semibold">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Button that asks for confirmation before running `onConfirm`. */
export function ConfirmButton({ label, title, message, confirmLabel = "Confirm", onConfirm, variant = "danger", size = "sm" }: {
  label: ReactNode;
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | unknown;
  variant?: "danger" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} locked={busy} title={title}>
        <div className="mb-5 text-sm text-zinc-600 dark:text-zinc-400">{message}</div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
                setOpen(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
