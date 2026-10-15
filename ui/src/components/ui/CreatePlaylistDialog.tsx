import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlaylistPrivacy } from "@/lib/api/types";
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

/** Modal that creates an empty playlist; the caller adds the songs afterwards. */
export const CreatePlaylistDialog = ({
  initialTitle,
  onCancel,
  onSubmit,
}: {
  /** Pre-filled name, e.g. when the dialog opened from an add flow. */
  initialTitle?: string;
  onCancel: () => void;
  /** Creates the playlist on YouTube Music; resolves with its id, or null on failure. */
  onSubmit: (title: string, description: string, privacy: PlaylistPrivacy) => Promise<string | null>;
}) => {
  const [title, setTitle] = useState(initialTitle ?? "");
  const [description, setDescription] = useState("");
  const [privacy, setPrivacy] = useState<PlaylistPrivacy>("PRIVATE");
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel, pending]);

  const canSubmit = title.trim().length > 0 && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    await onSubmit(title.trim(), description, privacy);
    setPending(false);
  };

  return createPortal(
    <Modal pending={pending} onPointerDownOutside={onCancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-lg font-bold">New playlist</h2>

        <div className="mt-3 flex flex-col gap-3">
          <label className="block text-sm text-primary-dark">
            Name
            <input
              ref={inputRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={150}
              className="mt-1 w-full rounded-lg bg-primary-light px-3 py-2 text-primary outline-none focus:ring-2 focus:ring-white/15"
            />
          </label>
          <label className="block text-sm text-primary-dark">
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={5000}
              rows={3}
              placeholder="Optional"
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
                  "group flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-sm transition-colors",
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

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-primary/20 pt-3">
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
            className="flex cursor-pointer items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black transition-colors hover:bg-white/85 disabled:opacity-40"
          >
            {pending && (
              <span aria-hidden="true" className="icon-[solar--loader-linear] animate-spin text-base" />
            )}
            {pending ? "Creating" : "Create"}
          </button>
        </div>
      </form>
    </Modal>,
    document.body,
  );
};
