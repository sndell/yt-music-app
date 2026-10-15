import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaylistPrivacy } from "@/lib/api/types";
import { CreatePlaylistDialog } from "./CreatePlaylistDialog";

const spinners = () => document.querySelectorAll(".animate-spin").length;

const setup = (onSubmit: (title: string, description: string, privacy: PlaylistPrivacy) => Promise<string | null>) => {
  render(<CreatePlaylistDialog onCancel={() => {}} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Road trip" } });
  return screen.getByRole("button", { name: /create/i }).closest("form") as HTMLFormElement;
};

describe("CreatePlaylistDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("marks the create button busy while the request runs", async () => {
    // YouTube Music takes a moment to answer, so the button has to say it is
    // working instead of looking like the click was dropped.
    let finish: (playlistId: string | null) => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finish = resolve;
        }),
    );
    const form = setup(onSubmit);

    fireEvent.submit(form);

    expect(onSubmit).toHaveBeenCalledWith("Road trip", "", "PRIVATE");
    expect(spinners()).toBe(1);
    const busy = screen.getByRole("button", { name: /creating/i }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);

    await act(async () => {
      finish("PL1");
    });
    expect(spinners()).toBe(0);
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores a second submit while the request runs", async () => {
    const onSubmit = vi.fn(() => new Promise<string | null>(() => {}));
    const form = setup(onSubmit);

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
