// Treat permission errors as live: a second entry must not interrupt an owner
// it cannot inspect. Runs without an owner retain legacy recovery semantics.
export function hasLiveOwner(run) {
  if (!Number.isSafeInteger(run.ownerPid) || run.ownerPid < 1) return false;
  try {
    process.kill(run.ownerPid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
