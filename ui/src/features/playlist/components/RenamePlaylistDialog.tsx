import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Small modal for renaming an owned playlist. */
export const RenamePlaylistDialog = ({
  initialTitle,
  onCancel,
  onSubmit,
}: {
  initialTitle: string;
  onCancel: () => void;
  /** Resolves true when the rename succeeded, so the dialog can close. */
  onSubmit: (title: string) => Promise<boolean>;
}) => {
  const [title, setTitle] = useState(initialTitle);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel, pending]);

  const trimmed = title.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== initialTitle.trim() && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    const ok = await onSubmit(trimmed);
    setPending(false);
    if (ok) onCancel();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] grid place-items-center bg-black/60 p-4"
      onPointerDown={() => {
        if (!pending) onCancel();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-primary p-4 shadow-[0_20px_60px_rgb(0_0_0/0.7)]"
      >
        <h2 className="text-lg font-bold">Rename playlist</h2>
        <label className="mt-3 block text-sm text-primary-dark">
          Name
          <input
            ref={inputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={150}
            className="mt-1 w-full rounded-lg bg-primary-light px-3 py-2 text-primary outline-none focus:ring-2 focus:ring-accent"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="cursor-pointer rounded-full border border-primary px-4 py-1.5 text-sm hover:bg-primary-light disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="cursor-pointer rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black hover:bg-white/85 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
};
