import { guardDesktopSender } from "../credentials.mjs";

// Renderer intents are checked again by the fixed utility capability contract.
// The main host has no application context or business repository access.
export function registerCollectionIpc({
  ipcMain,
  backend,
  getWindow,
  getOrigin,
}) {
  const guarded = (method) =>
    guardDesktopSender({ getWindow, getOrigin }, (input) =>
      backend.call(method, input ?? {}),
    );
  for (const [channel, method] of Object.entries({
    "collection:boss-probe": "collection.bossProbe",
    "collection:status": "collection.status",
    "collection:capabilities": "collection.capabilities",
    "collection:login": "collection.login",
    "collection:verify": "collection.verify",
    "collection:clear": "collection.clear",
  }))
    ipcMain.handle(channel, guarded(method));
}
