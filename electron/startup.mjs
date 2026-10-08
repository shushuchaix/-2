// The HTTP server retains a safe maintenance surface when workspace startup fails.
// Normal desktop startup must keep that surface reachable; self-test must fail loudly.
export async function awaitDesktopContext(ready, { selfTest = false } = {}) {
  try {
    return await ready;
  } catch (error) {
    if (selfTest) throw error;
    return null;
  }
}
