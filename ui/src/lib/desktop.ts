import type { DesktopAdapter, DesktopBridge } from "./types";
export function createDesktopAdapter(bridge?: DesktopBridge): DesktopAdapter {
  const unavailable = async () => {
    throw Error("此操作需要桌面版，请在桌面软件中重试。");
  };
  return {
    available: !!bridge,
    getCollectionCapabilities: () =>
      bridge?.getCollectionCapabilities?.() ??
      Promise.resolve({ available: false, canRemember: false }),
    isAvailable: () => bridge?.isAvailable() ?? Promise.resolve(false),
    getKeyStatus: (p) => bridge?.getKeyStatus(p) ?? unavailable(),
    saveKey: (p, k) => bridge?.saveKey(p, k) ?? unavailable(),
    deleteKey: (p) => bridge?.deleteKey(p) ?? unavailable(),
    getDataLocations: () => bridge?.getDataLocations() ?? unavailable(),
    openDataLocation: (k) => bridge?.openDataLocation(k) ?? unavailable(),
    copyDataLocation: (k) => bridge?.copyDataLocation(k) ?? unavailable(),
    openCollectionLogin: (input) =>
      bridge?.openCollectionLogin?.(input) ?? unavailable(),
    verifyCollectionSession: (input) =>
      bridge?.verifyCollectionSession?.(input) ?? unavailable(),
    clearCollectionSession: (input) =>
      bridge?.clearCollectionSession?.(input) ?? unavailable(),
    getCollectionSessionStatus: (input) =>
      bridge?.getCollectionSessionStatus?.(input) ?? unavailable(),
    probeBossSession: (input) =>
      bridge?.probeBossSession?.(input) ?? unavailable(),
  };
}
