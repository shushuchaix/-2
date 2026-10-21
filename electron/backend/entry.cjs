// Electron's documented utility entry uses parentPort on process. Keep this
// CommonJS bootstrap small; dynamic import resolves the same .mjs path in ASAR.
const { pathToFileURL } = require("node:url");
const path = require("node:path");
import(pathToFileURL(path.join(__dirname, "service.mjs")).href)
  .then(({ startUtilityBackend }) => startUtilityBackend(process.parentPort))
  .catch(() => {
    // No raw exception or machine path crosses the startup boundary.
    process.parentPort.postMessage({
      backendBootstrapFailure: "backend_bootstrap_failed",
    });
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  });
