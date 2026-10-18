export const shutdownResourceIds = Object.freeze([
  "application",
  "browser",
  "server",
  "collection",
  "trash",
  "settings",
  "runs",
  "attachments",
  "ocr",
  "worker",
  "owned",
  "repository",
]);

export function desktopShutdownReceipt(failedResources = []) {
  const failed = [
    ...new Set(
      failedResources.map((id) =>
        shutdownResourceIds.includes(id) ? id : "application",
      ),
    ),
  ];
  return {
    stopped: true,
    cleanupComplete: failed.length === 0,
    failedResources: failed,
  };
}

/** Begin shutdown synchronously: reject new connections before closing live
 * keepalives. The returned promise is awaited after application drain. */
export function stopDesktopHttp(server) {
  if (!server) return Promise.resolve();
  const closed = server.listening
    ? new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    : Promise.resolve();
  server.closeAllConnections();
  return closed;
}
