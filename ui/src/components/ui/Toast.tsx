import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/util/cn";

export type ToastTone = "success" | "error";

export type ToastAction = {
  /** Short verb shown on the right of the message, e.g. "Undo". */
  label: string;
  /** Runs when the toast action is pressed; the toast closes right after. */
  onClick: () => void;
};

type ToastMessage = { id: number; message: string; tone: ToastTone; action?: ToastAction };

type ToastContextValue = {
  /** Show a short message above the player. */
  showToast: (message: string, tone?: ToastTone, action?: ToastAction) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_MS = 3200;
const TOAST_ACTION_MS = 5600;
const MAX_VISIBLE = 3;

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextIdRef = useRef(0);
  const timersRef = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer != null) window.clearTimeout(timer);
    timersRef.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, tone: ToastTone = "success", action?: ToastAction) => {
      const id = ++nextIdRef.current;
      setToasts((current) => [...current.slice(-(MAX_VISIBLE - 1)), { id, message, tone, action }]);
      // Undo offers benefit from staying a little longer than a plain toast.
      timersRef.current.set(id, window.setTimeout(() => dismiss(id), action ? TOAST_ACTION_MS : TOAST_MS));
    },
    [dismiss],
  );

  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-[60] flex w-max max-w-[80vw] -translate-x-1/2 flex-col items-center gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role="status"
              onClick={() => dismiss(toast.id)}
              className={cn(
                "pointer-events-auto flex max-w-full animate-tuner-swap cursor-pointer items-center gap-2 rounded-lg bg-black/95 px-3 py-2 text-sm text-primary shadow-[0_8px_24px_rgb(0_0_0/0.6)]",
                toast.tone === "error" && "text-red-400",
              )}
            >
              <span
                className={cn(
                  "shrink-0 text-lg",
                  toast.tone === "error"
                    ? "icon-[solar--danger-triangle-linear]"
                    : "icon-[solar--check-circle-bold] text-success",
                )}
              />
              <span className="min-w-0 truncate">{toast.message}</span>
              {toast.action ? (
                <ToastActionButton action={toast.action} tone={toast.tone} onDismiss={() => dismiss(toast.id)} />
              ) : null}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
};

const ToastActionButton = ({
  action,
  tone,
  onDismiss,
}: {
  action: ToastAction;
  tone: ToastTone;
  onDismiss: () => void;
}) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      onDismiss();
      action.onClick();
    }}
    className={cn(
      "shrink-0 cursor-pointer font-semibold uppercase hover:brightness-110",
      tone === "error" ? "text-red-400" : "text-success",
    )}
  >
    {action.label}
  </button>
);

export const useToast = () => {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used within ToastProvider");
  return value;
};
