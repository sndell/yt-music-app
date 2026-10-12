import { useEffect, useRef, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { PyBridge } from "@/lib/api/bridge";
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
  const [clientId, setClientId] = useState("");
  const clientIdDirty = useRef(false);
  const skipBlurSave = useRef(false);
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
      if (cancelled || !result.success || clientIdDirty.current || holdLocalStatus.current) return;
      setClientId(result.data.clientId);
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

  const saveDiscord = async (enabled: boolean, id: string) => {
    setDiscordWorking(true);
    const result = await PyBridge.setDiscordPresence(enabled, id.trim());
    setDiscordWorking(false);
    if (!result.success) {
      setDiscordState("error");
      setDiscordMessage(result.error.message);
      return;
    }
    if (result.data.accepted) {
      clientIdDirty.current = false;
      holdLocalStatus.current = false;
      setClientId(result.data.clientId);
      applyStatus(result.data, setDiscordEnabled, setDiscordConnected, setDiscordState, setDiscordMessage);
      return;
    }
    holdLocalStatus.current = true;
    setDiscordState("invalid");
    setDiscordMessage(result.data.message);
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
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5">
              <div>Discord</div>
              <p className="text-sm text-primary-dark">
                Shows the current song on your Discord profile. Create an application in the Discord developer portal,
                name it what should appear after "Listening to", and paste the application ID. No bot token. The Discord
                desktop app has to be open.
              </p>
            </div>
            <button
              type="button"
              data-discord-toggle="true"
              onMouseDown={() => {
                skipBlurSave.current = true;
              }}
              onClick={() => void saveDiscord(!discordEnabled, clientId)}
              disabled={!discordReady || discordWorking}
              className="h-8 shrink-0 cursor-pointer rounded-full border border-white/40 px-3 text-sm text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {discordWorking ? "Working..." : !discordReady ? "..." : discordEnabled ? "Turn off" : "Turn on"}
            </button>
          </div>
          <input
            value={clientId}
            onChange={(event) => {
              clientIdDirty.current = true;
              holdLocalStatus.current = false;
              setClientId(event.target.value);
            }}
            onBlur={(event) => {
              if (skipBlurSave.current) {
                skipBlurSave.current = false;
                return;
              }
              const next = event.relatedTarget;
              if (next instanceof HTMLElement && next.dataset.discordToggle === "true") return;
              if (!clientIdDirty.current) return;
              void saveDiscord(discordEnabled, clientId);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            disabled={!discordReady || discordWorking}
            inputMode="numeric"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Application ID"
            aria-label="Discord application ID"
            className="h-8 w-full max-w-xs rounded-full border border-white/40 bg-transparent px-3 text-sm text-white outline-none placeholder:text-white/40 focus:border-white disabled:opacity-50"
          />
          {discordMessage && (
            <p className={discordQuiet ? "text-sm text-primary-dark" : "text-sm text-red-500"}>{discordMessage}</p>
          )}
        </div>
      </div>
    </div>
  );
};
