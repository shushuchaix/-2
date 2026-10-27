// This contract is shared by the main host and the utility backend. The method
// table is the complete capability surface; there is no repository/SQL/eval RPC.
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v, max = 200) =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const id = (v) => string(v) && /^[A-Za-z0-9_.@:-]+$/.test(v);
const keys = (v, required, optional = []) =>
  object(v) &&
  required.every((k) => Object.hasOwn(v, k)) &&
  Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
const empty = (v) => keys(v, []);
const bool = (v) => typeof v === "boolean";
const uint = (v) => Number.isSafeInteger(v) && v >= 0;
export const rpcScope = (v) =>
  keys(v, ["packageId", "targetRevisionId"]) &&
  id(v.packageId) &&
  id(v.targetRevisionId);
const ref = (v) =>
  keys(v, ["scope"], ["activityId"]) &&
  rpcScope(v.scope) &&
  (v.activityId === undefined || id(v.activityId));
const platform = (v) => ["boss", "wechat", "weibo"].includes(v);
const session = (v) =>
  keys(v, ["scope", "sessionRef"]) && rpcScope(v.scope) && id(v.sessionRef);
const optional = (v, key, check) => !Object.hasOwn(v, key) || check(v[key]);
const token = (v) =>
  keys(v, ["epoch", "sliceRunId"], ["expectedRevision"]) &&
  uint(v.epoch) &&
  id(v.sliceRunId) &&
  optional(v, "expectedRevision", uint);
const lease = (v) =>
  keys(v, ["operationId", "token"]) && id(v.operationId) && id(v.token);
const operation = (v) =>
  keys(v, ["kind", "url", "method", "parameters"]) &&
  ["boss.search", "boss.detail"].includes(v.kind) &&
  string(v.url, 4096) &&
  ["POST", "GET"].includes(v.method) &&
  object(v.parameters);
const guarded = (v, extras = []) =>
  keys(v, ["ref", "token", "operationLease"], extras) &&
  ref(v.ref) &&
  id(v.ref.activityId) &&
  token(v.token) &&
  lease(v.operationLease);
const browserRead = (v, required = [], optionalKeys = []) =>
  guarded(v, [...required, ...optionalKeys]) &&
  required.every((k) => Object.hasOwn(v, k)) &&
  optional(v, "url", (s) => string(s, 4096)) &&
  optional(v, "testUrl", (s) => string(s, 4096)) &&
  optional(v, "platform", platform) &&
  optional(v, "sessionRef", id) &&
  optional(v, "operation", operation);
const metadataKeys = [
  "sessionRef",
  "platform",
  "state",
  "remembered",
  "riskBlocked",
  "code",
  "checkedAt",
  "sourceStatus",
  "issues",
  "bodyStatus",
  "status",
  "canRemember",
  "available",
];
const sessionMetadata = (v) =>
  object(v) &&
  Object.keys(v).every((key) => metadataKeys.includes(key)) &&
  [
    "sessionRef",
    "platform",
    "state",
    "code",
    "sourceStatus",
    "bodyStatus",
    "status",
  ].every((key) =>
    optional(
      v,
      key,
      (value) =>
        typeof value === "string" && /^[A-Za-z0-9_.@:-]{1,200}$/.test(value),
    ),
  ) &&
  ["remembered", "riskBlocked", "canRemember", "available"].every((key) =>
    optional(v, key, bool),
  ) &&
  optional(
    v,
    "checkedAt",
    (value) =>
      typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value),
  ) &&
  optional(
    v,
    "issues",
    (value) =>
      Array.isArray(value) &&
      value.length <= 100 &&
      value.every(
        (issue) =>
          keys(
            issue,
            ["code"],
            [
              "sourceId",
              "siteId",
              "diagnosticId",
              "requestId",
              "parentRequestId",
              "parentDiagnosticId",
              "phase",
              "failurePhase",
              "engine",
              "endpointKind",
              "httpStatus",
              "resultCategory",
              "retryable",
            ],
          ) &&
          id(issue.code) &&
          Object.entries(issue).every(([key, val]) =>
            key === "httpStatus"
              ? uint(val) && val <= 599
              : key === "retryable"
                ? bool(val)
                : typeof val === "string" &&
                  /^[A-Za-z0-9_.@:-]{1,200}$/.test(val),
          ),
      ),
  );
const result = (v) =>
  v === null || object(v) || Array.isArray(v) || typeof v === "boolean";
const allowance = (v) =>
  keys(
    v,
    ["reservationId", "kind", "requestUpperBound"],
    ["bytesUpperBound"],
  ) &&
  id(v.reservationId) &&
  ["browser", "resource", "dns"].includes(v.kind) &&
  uint(v.requestUpperBound) &&
  v.requestUpperBound <= 1 &&
  optional(v, "bytesUpperBound", uint);
const settlement = (v) =>
  keys(v, ["reservationId"], ["kind", "verifiedUsage"]) &&
  id(v.reservationId) &&
  optional(v, "kind", (kind) =>
    ["browser", "resource", "dns"].includes(kind),
  ) &&
  optional(
    v,
    "verifiedUsage",
    (u) =>
      keys(u, ["requests", "bytes"]) &&
      uint(u.requests) &&
      u.requests <= 1 &&
      uint(u.bytes),
  );
const items = (v, key, check) =>
  Array.isArray(v[key]) &&
  v[key].length > 0 &&
  v[key].length <= 64 &&
  v[key].every(check);
const browserResponse = (v) =>
  keys(
    v,
    ["status"],
    [
      "url",
      "html",
      "text",
      "payload",
      "code",
      "bodyStatus",
      "channel",
      "usage",
      "checkedAt",
      "diagnosticId",
      "requestId",
    ],
  ) &&
  uint(v.status) &&
  optional(
    v,
    "html",
    (s) => typeof s === "string" && Buffer.byteLength(s) <= 8388608,
  ) &&
  optional(
    v,
    "text",
    (s) => typeof s === "string" && Buffer.byteLength(s) <= 8388608,
  );
const c = (input, output = result) => Object.freeze({ input, output });
export const desktopCapabilities = Object.freeze({
  "backend.start": c(
    (v) =>
      keys(v, ["modelKey"]) &&
      typeof v.modelKey === "string" &&
      v.modelKey.length <= 4096,
  ),
  "backend.status": c(empty),
  "backend.shutdown": c(empty),
  "backend.modelKey": c(
    (v) =>
      keys(v, ["key"]) && typeof v.key === "string" && v.key.length <= 4096,
  ),
  "host.stage": c(
    (v) =>
      keys(v, ["stage", "state"], ["origin", "code", "diagnosticId"]) &&
      ["starting", "listening", "ready", "maintenance", "failed"].includes(
        v.state,
      ) &&
      id(v.stage) &&
      optional(v, "origin", (s) => /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(s)),
  ),
  "host.credentials.saveModel": c(
    (v) =>
      keys(v, ["apiKey"]) &&
      typeof v.apiKey === "string" &&
      v.apiKey.length <= 4096,
    (v) => keys(v, ["configured"]) && bool(v.configured),
  ),
  "host.sessions.recover": c(empty),
  "host.sessions.get": c(session, sessionMetadata),
  "host.sessions.status": c(session, sessionMetadata),
  "host.sessions.capabilities": c(empty, sessionMetadata),
  "host.browser.configure": c(
    (v) =>
      keys(v, ["dnsMode"]) && ["auto", "system", "doh"].includes(v.dnsMode),
  ),
  "host.browser.openLogin": c(
    (v) =>
      keys(
        v,
        ["ref", "platform", "accountRef", "remember"],
        ["sessionRef", "testUrl"],
      ) &&
      ref(v.ref) &&
      platform(v.platform) &&
      string(v.accountRef, 160) &&
      bool(v.remember) &&
      optional(v, "sessionRef", id) &&
      optional(v, "testUrl", (s) => string(s, 4096)),
    sessionMetadata,
  ),
  "host.browser.read": c(
    (v) => browserRead(v, ["url", "platform"], ["sessionRef"]),
    browserResponse,
  ),
  "host.browser.readBoss": c(
    (v) => browserRead(v, ["operation", "sessionRef"]),
    browserResponse,
  ),
  "host.browser.recoverBossSession": c((v) =>
    browserRead(v, ["operation", "sessionRef"]),
  ),
  "host.browser.verifySession": c(
    (v) => browserRead(v, ["testUrl", "sessionRef"]),
    sessionMetadata,
  ),
  "host.browser.clearSession": c(session),
  "host.browser.closePackage": c(
    (v) => keys(v, ["packageId"]) && id(v.packageId),
  ),
  "host.browser.stop": c(empty),
  "browser.scope.assert": c((v) => keys(v, ["scope"]) && rpcScope(v.scope)),
  "browser.session.remember": c(
    (v) =>
      keys(v, ["scope", "platform", "sessionRef"]) &&
      rpcScope(v.scope) &&
      platform(v.platform) &&
      id(v.sessionRef),
  ),
  "browser.session.forget": c(session),
  "browser.ledger.snapshot": c(ref),
  "browser.ledger.reserve": c(
    (v) =>
      guarded(v, [
        "reservationId",
        "kind",
        "requestUpperBound",
        "bytesUpperBound",
      ]) &&
      allowance(
        Object.fromEntries(
          Object.entries(v).filter(
            ([k]) => !["ref", "token", "operationLease"].includes(k),
          ),
        ),
      ),
  ),
  "browser.ledger.reserveBatch": c(
    (v) => guarded(v, ["reservations"]) && items(v, "reservations", allowance),
  ),
  // Drain settlements deliberately accept the original lease and token. The
  // backend ledger decides whether that exact pre-reserved allowance can settle.
  "browser.ledger.settle": c(
    (v) =>
      keys(
        v,
        ["ref", "operationLease", "reservationId"],
        ["token", "kind", "verifiedUsage", "draining"],
      ) &&
      ref(v.ref) &&
      lease(v.operationLease) &&
      optional(v, "token", token) &&
      settlement(
        Object.fromEntries(
          Object.entries(v).filter(
            ([k]) =>
              !["ref", "token", "operationLease", "draining"].includes(k),
          ),
        ),
      ),
  ),
  "browser.ledger.settleBatch": c(
    (v) =>
      keys(
        v,
        ["ref", "operationLease", "settlements"],
        ["token", "draining"],
      ) &&
      ref(v.ref) &&
      lease(v.operationLease) &&
      optional(v, "token", token) &&
      optional(v, "draining", bool) &&
      items(v, "settlements", settlement),
  ),
  "collection.login": c(
    (v) =>
      keys(
        v,
        ["scope", "platform", "accountRef"],
        ["activityId", "remember", "sessionRef", "testUrl"],
      ) &&
      rpcScope(v.scope) &&
      platform(v.platform) &&
      string(v.accountRef, 160) &&
      optional(v, "activityId", id) &&
      optional(v, "sessionRef", id) &&
      optional(v, "remember", bool) &&
      optional(v, "testUrl", (s) => string(s, 4096)),
    sessionMetadata,
  ),
  "collection.verify": c(
    (v) =>
      keys(v, ["scope", "activityId", "sessionRef", "testUrl"]) &&
      rpcScope(v.scope) &&
      id(v.activityId) &&
      id(v.sessionRef) &&
      string(v.testUrl, 4096),
    sessionMetadata,
  ),
  "collection.bossProbe": c(
    (v) =>
      keys(
        v,
        ["scope", "activityId", "sessionRef", "requestId"],
        ["clearRisk"],
      ) &&
      rpcScope(v.scope) &&
      id(v.activityId) &&
      id(v.sessionRef) &&
      id(v.requestId) &&
      optional(v, "clearRisk", bool),
    sessionMetadata,
  ),
  "collection.clear": c(session),
  "collection.status": c(session, sessionMetadata),
  "collection.capabilities": c(empty, sessionMetadata),
});

export function serializableBrowserInput(input) {
  const result = {};
  for (const key of [
    "ref",
    "token",
    "url",
    "operation",
    "sessionRef",
    "testUrl",
  ])
    if (input[key] !== undefined) result[key] = input[key];
  if (input.operationLease)
    result.operationLease = {
      operationId: input.operationLease.operationId,
      token: input.operationLease.token,
    };
  if (input.routePolicy?.platform) result.platform = input.routePolicy.platform;
  return result;
}
