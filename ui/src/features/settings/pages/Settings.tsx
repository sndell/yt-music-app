import { generateAuthHeader } from "@/lib/api/bridge";
import { useCallback, useState } from "react";

export const Settings = () => {
  const [headerInput, setHeaderInput] = useState("");

  const handleSaveAuthHeaders = useCallback(async () => {
    await generateAuthHeader(headerInput);
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
              className="px-3 bg-secondary hover:bg-secondary-light transition-colors py-1.5 rounded-lg cursor-pointer"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
