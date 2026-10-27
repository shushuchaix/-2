// Keep this module free of optional builtins so older Node can report the requirement
// before a caller dynamically imports node:sqlite or other runtime capabilities.
export const SUPPORTED_NODE_RANGE = ">=24.16.0 <25";

function releaseParts(version) {
  if (typeof version !== "string" || version.length > 100) return null;
  // A prerelease does not satisfy this stable-release range. Build metadata does.
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match || match[0] !== version) return null;
  const parts = match.slice(1, 4).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isSupportedNodeVersion(version) {
  const parts = releaseParts(version);
  return parts !== null && parts[0] === 24 && parts[1] >= 16;
}

export function assertSupportedNodeRuntime(version = process.versions.node) {
  if (isSupportedNodeVersion(version)) return;
  const detected = releaseParts(version) ? version : "未知版本";
  throw Object.assign(
    new Error(
      `当前 Node.js ${detected} 不受支持。请使用 Node.js 24.x，至少 24.16.0，低于 25（${SUPPORTED_NODE_RANGE}）。`,
    ),
    { code: "runtime_unsupported", requiredNode: SUPPORTED_NODE_RANGE },
  );
}
