import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Modal } from "@/components/ui/Modal";

/** Small blocker modal that asks before a destructive edit actually runs. */
export const ConfirmDialog = ({
  title,
  message,
  confirmLabel,
  danger = false,
  busyLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  /** Body text or nodes, e.g. the affected playlist and song names. */
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Shown on the button while the request runs; defaults to the normal label. */
  busyLabel?: string;
  onConfirm: () => Promise<boolean>;
  onCancel: () => void;
}) => {
  const [pending, setPending] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel, pending]);

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    const ok = await onConfirm();
    setPending(false);
    if (ok) onCancel();
  };

  return createPortal(
    <Modal pending={pending} onPointerDownOutside={onCancel} cardClassName="max-w-sm">
      <div role="alertdialog">
        <h2 className="text-lg font-bold">{title}</h2>
        <div className="mt-2 text-sm text-primary-dark">{message}</div>
        <div className="mt-4 flex justify-end gap-2 border-t border-primary/20 pt-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="cursor-pointer rounded-full px-4 py-1.5 text-sm text-primary-dark transition-colors hover:bg-primary-light hover:text-primary disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={pending}
            className={`cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-40 ${
              danger
                ? "bg-red-500 text-white hover:bg-red-500/90"
                : "bg-white text-black hover:bg-white/85"
            }`}
          >
            {pending ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>,
    document.body,
  );
};
