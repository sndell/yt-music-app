import { useState } from "react";
import { PyBridge } from "@/lib/api/bridge";

export const Settings = () => {
  const [headerInput, setHeaderInput] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSave = async () => {
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
  };

  return (
    <div className="flex justify-center">
      <div className="w-full max-w-7xl p-1.5">
        <div className="pb-3 text-2xl">Settings</div>
        <div className="space-y-1.5">
          <div>Auth Headers</div>
          <div className="flex gap-3">
            <input
              value={headerInput}
              onChange={(e) => setHeaderInput(e.target.value)}
              placeholder="Enter auth headers"
              className="px-3 py-1.5 w-full rounded-lg outline-none bg-primary-light"
            />
            <button
              onClick={handleSave}
              disabled={status === "saving" || !headerInput.trim()}
              className="px-3 py-1.5 rounded-lg transition-colors cursor-pointer bg-secondary hover:bg-secondary-light disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status === "saving" ? "Saving..." : "Save"}
            </button>
          </div>
          {status === "success" && <div className="text-sm text-green-500">Headers saved successfully!</div>}
          {status === "error" && errorMessage && <div className="text-sm text-red-500">{errorMessage}</div>}
        </div>
      </div>
    </div>
  );
};
