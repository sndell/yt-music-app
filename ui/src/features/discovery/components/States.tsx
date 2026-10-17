/**
 * The three states every discovery page needs, so a later page copies one shape
 * instead of inventing its own: still loading, a failed read with a retry, and
 * an honest empty page. An empty payload is never replaced by a spinner.
 */

export const Loading = ({ label }: { label: string }) => (
  <div className="grid place-items-center py-12" role="status" aria-label={label}>
    <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
  </div>
);

export const LoadError = ({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <p className="py-8 text-sm text-red-400" role="alert">
    {message}{" "}
    <button type="button" onClick={onRetry} className="cursor-pointer text-primary hover:underline">
      Try again
    </button>
  </p>
);

export const Empty = ({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <p className="py-8 text-sm text-primary-dark">
    {message}{" "}
    <button type="button" onClick={onRetry} className="cursor-pointer text-primary hover:underline">
      Reload
    </button>
  </p>
);
