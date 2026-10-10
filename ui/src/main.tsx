import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { createApiClient } from "./lib/api";
import { createDesktopAdapter } from "./lib/desktop";
import type { DesktopBridge } from "./lib/types";
import "./styles.css";
const bridge = (window as Window & { desktopBridge?: DesktopBridge })
  .desktopBridge;
const api = createApiClient({
  reportDiagnostic: (event) =>
    bridge?.reportDiagnostic?.(event) ?? Promise.resolve(undefined),
});
createRoot(document.getElementById("root")!).render(
  <App api={api} desktop={createDesktopAdapter(bridge)} />,
);
