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

// Focusing a hidden BrowserWindow does not reveal it. Use the same presentation
// path after loading and when Windows forwards a second launch to this instance.
export function presentDesktopWindow(window, { selfTest = false } = {}) {
  if (selfTest || !window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  return window.isVisible();
}
