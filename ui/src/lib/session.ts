import { useEffect, useState } from "react";
import { PyBridge } from "@/lib/api";
import { onPythonEvent } from "@/lib/pythonEvents";

/**
 * Whether the app holds a sign-in YouTube still accepts. `expired` means a
 * sign-in is saved but YouTube answered signed out for it, which happens when
 * Google ends the session (a sign-out elsewhere, a password change).
 */
export type Session = { signedIn: boolean; expired: boolean };

const listeners = new Set<(session: Session) => void>();
let cached: Session | null = null;

const publish = (session: Session) => {
  cached = session;
  for (const listener of listeners) listener(session);
};

export const refreshSession = async () => {
  const result = await PyBridge.isSignedIn();
  if (result.success) publish(result.data);
};

onPythonEvent("sessionExpired", () => {
  publish({ signedIn: false, expired: true });
  // The pages that read the library reload into their signed-out state.
  window.dispatchEvent(new Event("ytmusic-auth-changed"));
});

window.addEventListener("ytmusic-auth-changed", () => void refreshSession());

/** Null until the first answer arrives. */
export const useSession = () => {
  const [session, setSession] = useState(cached);
  useEffect(() => {
    listeners.add(setSession);
    if (cached == null) void refreshSession();
    return () => {
      listeners.delete(setSession);
    };
  }, []);
  return session;
};
