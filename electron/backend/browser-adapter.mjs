import { serializableBrowserInput } from "./protocol.mjs";

/** Service adapter lives in the backend. Native handles, policies, signals,
 * request functions and operation-lease release methods stay in their host. */
export function createBackendBrowserAdapter(
  peer,
  { getCallSignal = () => null } = {},
) {
  const signalFor = (input) => {
    const signals = [input?.signal, getCallSignal()].filter(Boolean);
    return signals.length ? AbortSignal.any(signals) : undefined;
  };
  const call = (method, input) =>
    peer.call(method, serializableBrowserInput(input), {
      signal: signalFor(input),
      timeoutMs: 120000,
    });
  return {
    read: (input) => call("host.browser.read", input),
    readBoss: (input) => call("host.browser.readBoss", input),
    verifySession: (input) => call("host.browser.verifySession", input),
    recoverBossSession: (input) =>
      call("host.browser.recoverBossSession", input),
    openLogin: (input) =>
      peer.call("host.browser.openLogin", input, {
        signal: signalFor(input),
        timeoutMs: 120000,
      }),
    clearSession: (input) =>
      peer.call("host.browser.clearSession", input, { timeoutMs: 120000 }),
    closePackage: (packageId) =>
      peer.call(
        "host.browser.closePackage",
        { packageId },
        { timeoutMs: 120000 },
      ),
    stop: () => peer.call("host.browser.stop", {}, { timeoutMs: 30000 }),
  };
}
