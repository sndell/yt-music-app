import { useCallback, useState } from "react";
import { PyBridge } from "@/lib/api/bridge";

export const Settings = () => {
  const [headerInput, setHeaderInput] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSaveAuthHeaders = useCallback(async () => {
    setStatus("saving");
    setErrorMessage(null);

    const result = await PyBridge.generateAuthHeader(headerInput);

    if (result.success) {
      setStatus("success");
      setHeaderInput("");
    } else {
      setStatus("error");
      setErrorMessage(result.error.message);
    }
  }, [headerInput]);

  return (
    <div className="flex justify-center">
      <div className="w-full max-w-7xl p-1.5">
        <div className="pb-3 text-2xl">Settings</div>
        <div className="space-y-1.5">
          <div>Auth Headers</div>
          <div className="flex gap-3">
            <textarea
              value={headerInput}
              rows={4}
              onChange={(e) => setHeaderInput(e.target.value)}
              placeholder="Enter auth headers"
              className="px-3 w-full rounded-lg bg-primary-light py-1.5 outline-none"
            />
            <button
              onClick={handleSaveAuthHeaders}
              disabled={status === "saving" || !headerInput.trim()}
              className="px-3 bg-secondary hover:bg-secondary-light transition-colors py-1.5 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status === "saving" ? "Saving..." : "Save"}
            </button>
          </div>
          {status === "success" && (
            <div className="text-green-500 text-sm">Headers saved successfully!</div>
          )}
          {status === "error" && errorMessage && (
            <div className="text-red-500 text-sm">{errorMessage}</div>
          )}
        </div>
      </div>
    </div>
  );
};
