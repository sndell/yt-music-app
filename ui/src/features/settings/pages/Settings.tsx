import { useEffect, useState } from "react";
import { PyBridge } from "@/lib/api/bridge";

const notifyAuthChanged = () => {
  window.dispatchEvent(new Event("ytmusic-auth-changed"));
};

export const Settings = () => {
  const [signInStatus, setSignInStatus] = useState<"idle" | "working" | "error">("idle");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    PyBridge.isSignedIn().then((result) => {
      if (!cancelled) setSignedIn(result.success ? result.data.signedIn : false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  return (
    <div className="flex justify-center">
      <div className="w-full max-w-7xl p-1.5 px-3">
        <div className="pb-3 text-2xl">Settings</div>
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
              onClick={signedIn ? handleSignOut : handleSignIn}
              disabled={signInStatus === "working" || signedIn == null}
              className="px-3 py-1.5 rounded-lg transition-colors cursor-pointer shrink-0 bg-secondary hover:bg-secondary-light disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {signInStatus === "working" ? "Working..." : signedIn == null ? "..." : signedIn ? "Sign out" : "Sign in"}
            </button>
          </div>
          {signInStatus === "error" && signInError && <div className="text-sm text-red-500">{signInError}</div>}
        </div>
      </div>
    </div>
  );
};
