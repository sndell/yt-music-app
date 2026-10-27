import { useEffect } from "react";
import { useToast } from "@/components/ui/Toast";
import { onPythonEvent } from "@/lib/pythonEvents";

/** Tells the user once when YouTube stops accepting the saved sign-in. */
export const SessionNotice = () => {
  const { showToast } = useToast();
  useEffect(
    () =>
      onPythonEvent("sessionExpired", () => {
        showToast("Your YouTube Music session expired.", "error", {
          label: "Sign in",
          onClick: () => {
            window.location.hash = "#/settings";
          },
        });
      }),
    [showToast],
  );
  return null;
};
