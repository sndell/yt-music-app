import { useEffect, useRef, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { PyBridge } from "@/lib/api";
import { saveHorizontalNav, useHorizontalNav } from "@/lib/horizontalNav";
import type { DiscordPresenceStatus } from "@/lib/api/types";

const notifyAuthChanged = () => {
  window.dispatchEvent(new Event("ytmusic-auth-changed"));
};

const applyStatus = (
  status: DiscordPresenceStatus,
  setEnabled: (value: boolean) => void,
  setConnected: (value: boolean) => void,
  setPresenceState: (value: DiscordPresenceStatus["state"]) => void,
  setMessage: (value: string) => void
) => {
  setEnabled(status.enabled);
  setConnected(status.connected);
  setPresenceState(status.state);
  setMessage(status.message);
};

export const Settings = () => {
  const [signInStatus, setSignInStatus] = useState<"idle" | "working" | "error">("idle");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [discordReady, setDiscordReady] = useState(false);
  const [discordWorking, setDiscordWorking] = useState(false);
  const [discordEnabled, setDiscordEnabled] = useState(false);
  const [discordConnected, setDiscordConnected] = useState(false);
  const [discordState, setDiscordState] = useState<DiscordPresenceStatus["state"]>("off");
  const [discordMessage, setDiscordMessage] = useState("");
  const holdLocalStatus = useRef(false);

  useEffect(() => {
    let cancelled = false;
    PyBridge.isSignedIn().then((result) => {
      if (!cancelled) setSignedIn(result.success ? result.data.signedIn : false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const result = await PyBridge.getDiscordPresence();
      if (cancelled || !result.success || holdLocalStatus.current) return;
      applyStatus(result.data, setDiscordEnabled, setDiscordConnected, setDiscordState, setDiscordMessage);
      setDiscordReady(true);
    };

    void load();
    const waiting = discordEnabled && !discordConnected && (discordState === "connecting" || discordState === "waiting");
    if (!waiting) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => {
      void load();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [discordEnabled, discordConnected, discordState]);

  const saveDiscord = async (enabled: boolean) => {
    holdLocalStatus.current = false;
    setDiscordWorking(true);
    const result = await PyBridge.setDiscordPresence(enabled);
    setDiscordWorking(false);
    if (!result.success) {
      holdLocalStatus.current = true;
      setDiscordState("error");
      setDiscordMessage(result.error.message);
      return;
    }
    applyStatus(result.data, setDiscordEnabled, setDiscordConnected, setDiscordState, setDiscordMessage);
  };

  const handleSignIn = async () => {
    setSignInStatus("working");
    setSignInError(null);

    const result = await PyBridge.signIn();

    if (result.success) {
      setSignedIn(true);
      setSignInStatus("idle");
      notifyAuthChanged();
    } else {
      setSignInStatus("error");
      setSignInError(result.error.message);
    }
  };

  const handleSignOut = async () => {
    setSignInStatus("working");
    setSignInError(null);

    const result = await PyBridge.signOut();

    if (result.success) {
      setSignedIn(false);
      setSignInStatus("idle");
      notifyAuthChanged();
    } else {
      setSignInStatus("error");
      setSignInError(result.error.message);
    }
  };

  const discordQuiet = discordState === "connected" || discordState === "connecting" || discordState === "waiting";
  const horizontalNav = useHorizontalNav();
  const [navWorking, setNavWorking] = useState(false);

  const saveNav = async (enabled: boolean) => {
    setNavWorking(true);
    await saveHorizontalNav(enabled);
    setNavWorking(false);
  };

  return (
    <div className="flex justify-center">
      <div className="w-full max-w-7xl p-1.5 px-3">
        <PageHeading>Settings</PageHeading>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1.5">
              <div>YouTube Music</div>
              <p className="text-sm text-primary-dark">
                {signedIn
                  ? "Signed in to YouTube Music."
                  : "Opens YouTube Music and reads the signed-in API request itself. Log in if YouTube asks; the window closes when the headers are captured."}
              </p>
            </div>
            <button
              type="button"
              onClick={signedIn ? handleSignOut : handleSignIn}
              disabled={signInStatus === "working" || signedIn == null}
              className="h-8 shrink-0 cursor-pointer rounded-full border border-white/40 px-3 text-sm text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {signInStatus === "working" ? "Working..." : signedIn == null ? "..." : signedIn ? "Sign out" : "Sign in"}
            </button>
          </div>
          {signInStatus === "error" && signInError && <div className="text-sm text-red-500">{signInError}</div>}
        </div>

        <div className="mt-8 space-y-3 border-t border-white/10 pt-6">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1.5">
              <div>Discord</div>
              <p className="text-sm text-primary-dark">
                Shows the current song on your Discord profile while YouTube Music is playing. The Discord desktop app
                has to be open.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void saveDiscord(!discordEnabled)}
              disabled={!discordReady || discordWorking}
              className="h-8 shrink-0 cursor-pointer rounded-full border border-white/40 px-3 text-sm text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {discordWorking ? "Working..." : !discordReady ? "..." : discordEnabled ? "Turn off" : "Turn on"}
            </button>
          </div>
          {discordMessage && (
            <p className={discordQuiet ? "text-sm text-primary-dark" : "text-sm text-red-500"}>{discordMessage}</p>
          )}
        </div>

        <div className="mt-8 space-y-3 border-t border-white/10 pt-6">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1.5">
              <div>Horizontal navigation</div>
              <p className="text-sm text-primary-dark">
                Puts the navigation buttons in a single icon-only row at the top of the sidebar, so playlist rows get
                bigger covers. Only applies when the window is wide enough to fit the row.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void saveNav(!horizontalNav)}
              disabled={navWorking}
              className="h-8 shrink-0 cursor-pointer rounded-full border border-white/40 px-3 text-sm text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {navWorking ? "Working..." : horizontalNav ? "Turn off" : "Turn on"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
