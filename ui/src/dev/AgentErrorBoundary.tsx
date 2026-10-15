import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportRendererEntry } from "./agentBridge";

/** Captures render errors (dev only) so a broken tree reports instead of going blank. */
export class AgentErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRendererEntry({
      level: "error",
      kind: "react",
      message: error.message || "render error",
      stack: `${error.stack || ""}\n${info.componentStack || ""}`,
    });
  }

  render() {
    if (this.state.failed) {
      return (
        <div style={{ padding: 24, fontFamily: "monospace", color: "#f88", fontSize: 13 }}>
          Render error. It is in the probe logs (`tools/dev.py logs`).
        </div>
      );
    }
    return this.props.children;
  }
}
