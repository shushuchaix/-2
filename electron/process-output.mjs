// Windows GUI launches can outlive the terminal pipe that started them.
// Losing that pipe must not turn a diagnostic console write into a fatal error.
export function installClosedPipeGuard({
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const onError = (error) => {
    if (error?.code === "EPIPE") return;
    throw error;
  };
  stdout?.on("error", onError);
  stderr?.on("error", onError);
  return () => {
    stdout?.off("error", onError);
    stderr?.off("error", onError);
  };
}
