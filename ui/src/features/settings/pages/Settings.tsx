import { useEffect, useRef, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Switch } from "@/components/ui/Switch";
import { PyBridge } from "@/lib/api";
import { saveCrossfadeSeconds, useCrossfadeSeconds } from "@/lib/crossfade";
import { saveHorizontalNav, useHorizontalNav } from "@/lib/horizontalNav";
import { cn } from "@/util/cn";
import { Dot } from "@/components/ui/Dot";
import type { DiscordPresenceStatus, UpdateStatus } from "@/lib/api/types";
import { useUpdateStatus } from "@/lib/updateStatus";
import { SettingsAction, SettingsRow, SettingsSection } from "../components/SettingsSection";
import { EqualizerSection } from "../components/EqualizerSection";

/** The lengths offered in Settings, in seconds. Zero leaves each song to end on its own. */
const CROSSFADE_CHOICES = [0, 3, 6, 9, 12];

const notifyAuthChanged = () => {
  window.dispatchEvent(new Event("ytmusic-auth-changed"));
};

const updateDetail = (update: UpdateStatus | null, error: string | null, stage: "idle" | "installing" | "restarting") => {
  if (stage === "restarting") return "Restarting with the new version. The window reopens on its own.";
  if (stage === "installing") return "Downloading and checking the new build...";
  if (update?.error) return "Could not check for updates.";
  if (!update) return error ? "Could not check for updates." : "Checking for updates...";
  if (!update.available) return "Up to date.";
  if (!update.frozen) return `${update.latest} is available. Updates install in the packaged YTMusic.exe.`;
  return `${update.latest} is available. The window closes and reopens to finish.`;
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
  // Shared with the sidebar badge, so both read the same one check.
  const { status: update, error: updateError } = useUpdateStatus();
  const [updateStage, setUpdateStage] = useState<"idle" | "installing" | "restarting">("idle");
  const [installError, setInstallError] = useState<string | null>(null);

  const installUpdate = async () => {
    setInstallError(null);
    setUpdateStage("installing");
    const result = await PyBridge.installUpdate();
    if (!result.success) {
      setUpdateStage("idle");
      setInstallError(result.error.message);
      return;
    }
    setUpdateStage("restarting");
  };

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

  const horizontalNav = useHorizontalNav();
  const [navWorking, setNavWorking] = useState(false);
  const crossfade = useCrossfadeSeconds();
  const [crossfadeWorking, setCrossfadeWorking] = useState(false);

  const saveNav = async (enabled: boolean) => {
    setNavWorking(true);
    await saveHorizontalNav(enabled);
    setNavWorking(false);
  };

  const signedInDescription = signedIn
    ? "Signed in to YouTube Music."
    : "Opens YouTube Music to capture the signed-in API request. Log in there if asked; the window closes when the headers are read.";

  const saveCrossfade = async (seconds: number) => {
    setCrossfadeWorking(true);
    await saveCrossfadeSeconds(seconds);
    setCrossfadeWorking(false);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto w-full max-w-2xl">
          <PageHeading>Settings</PageHeading>
          <div className="space-y-8">
            <SettingsSection title="Account">
              <SettingsRow
                title="YouTube Music"
                description={signedInDescription}
                detail={signInStatus === "error" ? signInError : null}
                detailTone="error"
                control={
                  <SettingsAction
                    onClick={() => void (signedIn ? handleSignOut() : handleSignIn())}
                    disabled={signInStatus === "working" || signedIn == null}
                  >
                    {signInStatus === "working"
                      ? "Working..."
                      : signedIn == null
                        ? "..."
                        : signedIn
                          ? "Sign out"
                          : "Sign in"}
                  </SettingsAction>
                }
              />
            </SettingsSection>

            <SettingsSection title="Appearance">
              <SettingsRow
                title="Horizontal navigation"
                description="Icon-only row at the top of the sidebar, so more playlists fit. Needs a window wide enough for the five icons."
                control={
                  <Switch
                    checked={horizontalNav}
                    onChange={(enabled) => void saveNav(enabled)}
                    disabled={navWorking}
                    label="Horizontal navigation"
                  />
                }
              />
            </SettingsSection>

            <SettingsSection title="Audio">
              <EqualizerSection />
              <SettingsRow
                title="Crossfade"
                description="Starts the next song before this one ends and blends the two. Off plays every song to its end, with the next one loaded in advance so the gap between them is as short as it can be."
                control={
                  <div className="flex shrink-0 items-center gap-1">
                    {CROSSFADE_CHOICES.map((seconds) => (
                      <button
                        key={seconds}
                        type="button"
                        onClick={() => void saveCrossfade(seconds)}
                        disabled={crossfadeWorking}
                        aria-pressed={crossfade === seconds}
                        className={cn(
                          "h-8 min-w-11 cursor-pointer rounded-full border px-2.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                          crossfade === seconds ? "border-accent bg-accent/15 text-accent" : "border-white/40 text-white hover:bg-white/10",
                        )}
                      >
                        {seconds === 0 ? "Off" : `${seconds}s`}
                      </button>
                    ))}
                  </div>
                }
              />
            </SettingsSection>

            <SettingsSection title="Integrations">
              <SettingsRow
                title="Discord"
                description="Shows the current song on your Discord profile. The Discord desktop app has to be open."
                control={
                  <Switch
                    checked={discordEnabled}
                    onChange={(enabled) => void saveDiscord(enabled)}
                    disabled={!discordReady || discordWorking}
                    label="Discord rich presence"
                  />
                }
                detail={discordMessage}
                detailTone={discordState === "error" ? "error" : "quiet"}
              />
            </SettingsSection>

            <SettingsSection title="About" badge={update?.available ? <Dot /> : undefined}>
              <SettingsRow
                title="Version"
                description={updateDetail(update, updateError, updateStage)}
                detail={installError ?? updateError}
                detailTone="error"
                control={
                  <div className="flex items-center gap-3">
                    <span className="text-sm tabular-nums text-primary-dark">{update?.current ?? "..."}</span>
                    {update?.available && update.frozen && (
                      <SettingsAction primary onClick={() => void installUpdate()} disabled={updateStage !== "idle"}>
                        {updateStage === "installing"
                          ? "Downloading..."
                          : updateStage === "restarting"
                            ? "Restarting..."
                            : "Update"}
                      </SettingsAction>
                    )}
                  </div>
                }
              />
            </SettingsSection>
          </div>
        </div>
      </div>
    </div>
  );
};

