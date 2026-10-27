import { rpcScope } from "./protocol.mjs";
const obj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v, required, optional = []) =>
  obj(v) &&
  required.every((key) => Object.hasOwn(v, key)) &&
  Object.keys(v).every(
    (key) => required.includes(key) || optional.includes(key),
  );
const id = (v) => typeof v === "string" && /^[A-Za-z0-9_.@:-]{1,200}$/.test(v);
const empty = (v) => keys(v, []);
const output = (v) => obj(v);
const capability = (input) => ({ input, output });

// Loaded only under the native --self-test environment. These named fixture
// operations cannot evaluate source, run SQL, select tables or open paths.
export const syntheticCapabilities = Object.freeze({
  "synthetic.inspect": capability(empty),
  "synthetic.clock": capability(empty),
  "synthetic.advance": capability(
    (v) =>
      keys(v, ["ms"]) &&
      Number.isSafeInteger(v.ms) &&
      v.ms >= 0 &&
      v.ms <= 365 * 86400000,
  ),
  "synthetic.controls": capability(
    (v) =>
      keys(v, [], ["hold", "failCleanup", "failCleanupPackageId"]) &&
      ["hold", "failCleanup"].every(
        (key) => v[key] === undefined || typeof v[key] === "boolean",
      ) &&
      (v.failCleanupPackageId === undefined || id(v.failCleanupPackageId)),
  ),
  "synthetic.startGate": capability(
    (v) =>
      keys(v, ["action"]) && ["hold", "release", "status"].includes(v.action),
  ),
  "synthetic.duplicate": capability(
    (v) => keys(v, ["scope"]) && rpcScope(v.scope),
  ),
  "synthetic.score": capability(
    (v) =>
      keys(v, ["scope", "evaluationId"]) &&
      rpcScope(v.scope) &&
      id(v.evaluationId),
  ),
  "synthetic.removeScore": capability(
    (v) =>
      keys(v, ["scope", "evaluationId"]) &&
      rpcScope(v.scope) &&
      id(v.evaluationId),
  ),
  "synthetic.profile": capability(
    (v) =>
      keys(v, ["scenario"]) &&
      ["preview-conflict", "preview-revision", "ui-expiry", "expiry"].includes(
        v.scenario,
      ),
  ),
  "synthetic.archive": capability(
    (v) => keys(v, ["packageId"]) && id(v.packageId),
  ),
  "synthetic.sweep": capability(empty),
  "synthetic.activity": capability(
    (v) =>
      keys(v, ["ref"]) &&
      keys(v.ref, ["scope", "activityId"]) &&
      rpcScope(v.ref.scope) &&
      id(v.ref.activityId),
  ),
  "synthetic.bossContracts": capability(
    (v) =>
      keys(v, ["targets"]) &&
      Array.isArray(v.targets) &&
      v.targets.length === 2 &&
      v.targets.every(
        (item) =>
          keys(item, ["packageId", "revisionId"]) &&
          id(item.packageId) &&
          id(item.revisionId),
      ),
  ),
});
