const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "desktopBridge",
  Object.freeze({
    getDataLocations: () => ipcRenderer.invoke("directories:list"),
    openDataLocation: (kind) => ipcRenderer.invoke("directories:open", kind),
    copyDataLocation: (kind) => ipcRenderer.invoke("directories:copy", kind),
    isAvailable: () => ipcRenderer.invoke("credentials:available"),
    saveKey: (provider, key) =>
      ipcRenderer.invoke("credentials:save", provider, key),
    deleteKey: (provider) => ipcRenderer.invoke("credentials:delete", provider),
    getKeyStatus: (provider) =>
      ipcRenderer.invoke("credentials:status", provider),
    reportDiagnostic: (event) =>
      ipcRenderer.invoke("diagnostics:report", event),
  }),
);
