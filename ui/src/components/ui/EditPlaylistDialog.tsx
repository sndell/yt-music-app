import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlaylistPrivacy } from "@/lib/api/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/util/cn";

const PRIVACY_OPTIONS: { value: PlaylistPrivacy; label: string; iconClass: string; hint: string }[] = [
  { value: "PUBLIC", label: "Public", iconClass: "icon-[solar--globus-linear]", hint: "Anyone can find and play it" },
  { value: "UNLISTED", label: "Unlisted", iconClass: "icon-[solar--eye-linear]", hint: "Only people with the link" },
  {
    value: "PRIVATE",
    label: "Private",
    iconClass: "icon-[solar--lock-keyhole-minimalistic-linear]",
    hint: "Only you",
  },
];

/** Modal that edits an owned playlist's name, description and visibility, and can delete it. */
export const EditPlaylistDialog = ({
  initialTitle,
  initialDescription,
  initialPrivacy,
  onDelete,
  onCancel,
  onSubmit,
}: {
  initialTitle: string;
  initialDescription: string;
  initialPrivacy: PlaylistPrivacy;
  /** Runs after the delete option is confirmed. Resolves true when deleted. */
  onDelete: () => Promise<boolean>;
  onCancel: () => void;
  /** Applies the dialog's values to YouTube Music; resolves true when it succeeded. */
  onSubmit: (patch: { title: string; description: string; privacy: PlaylistPrivacy }) => Promise<boolean>;
}) => {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [privacy, setPrivacy] = useState<PlaylistPrivacy>(initialPrivacy);
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel, pending]);

  const detailsChanged =
    title.trim() !== initialTitle.trim() || description !== initialDescription || privacy !== initialPrivacy;
  const canSubmit = title.trim().length > 0 && detailsChanged && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    const ok = await onSubmit({ title: title.trim(), description, privacy });
    setPending(false);
    if (ok) onCancel();
  };

  return createPortal(
    <>
      <Modal pending={pending} onPointerDownOutside={onCancel} cardClassName="flex max-h-full flex-col">
        {/*
          The form is the scroll container, so overflow clips at its padding
          box. The inset padding gives the inputs' focus ring room to show at
          the left and right edges; the negative margin cancels it out, so the
          resting layout is unchanged.
        */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="-m-1 min-h-0 flex-1 overflow-y-auto p-1 scrollbar-thin"
        >
          <h2 className="text-lg font-bold">Edit playlist</h2>

          <div className="mt-3 flex flex-col gap-3">
            <label className="block text-sm text-primary-dark">
              Name
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={150}
                className="mt-1 w-full rounded-lg bg-primary-light px-3 py-2 text-primary outline-none focus:ring-2 focus:ring-white/15"
              />
            </label>
            <label className="block text-sm text-primary-dark">
              Description
              <textarea
                ref={inputRef}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={5000}
                rows={4}
                placeholder="Tell listeners what this playlist is about"
                className="mt-1 w-full resize-none rounded-lg bg-primary-light px-3 py-2 text-primary outline-none placeholder:text-primary-dark/50 focus:ring-2 focus:ring-white/15"
              />
            </label>
          </div>

          <div className="mt-4">
            <div className="text-sm text-primary-dark">Visibility</div>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {PRIVACY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.hint}
                  onClick={() => setPrivacy(option.value)}
                  className={cn(
                    "flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-sm transition-colors",
                    option.value === privacy
                      ? "border-primary/50 bg-primary-light text-primary"
                      : "border-transparent bg-transparent text-primary-dark hover:bg-primary-light/60",
                  )}
                >
                  <span aria-hidden="true" className="text-base leading-none">
                    <span className={option.iconClass} />
                  </span>
                  <span className="truncate">{option.label}</span>
                </button>
              ))}
            </div>
          </div>
        </form>

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-primary/20 pt-3">
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={pending}
            className="flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-primary-dark transition-colors hover:bg-primary-light hover:text-red-400 disabled:opacity-40"
          >
            <span aria-hidden="true" className="text-base leading-none">
              <span className="icon-[solar--trash-bin-minimalistic-linear]" />
            </span>
            Delete
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={pending}
              className="cursor-pointer rounded-full px-4 py-1.5 text-sm text-primary-dark transition-colors hover:bg-primary-light hover:text-primary disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="cursor-pointer rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black transition-colors hover:bg-white/85 disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      </Modal>

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete playlist?"
          message={
            <p>
              <span className="font-semibold text-primary">{initialTitle}</span> will be removed from your YouTube
              Music library. Its songs stay in your library.
            </p>
          }
          confirmLabel="Delete"
          busyLabel="Deleting…"
          danger
          onConfirm={onDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </>,
    document.body,
  );
};
