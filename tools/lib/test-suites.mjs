// Authoritative legacy registration. tests/**/*.test.mjs and tests/ui/*.test.tsx
// remain auto-discovered by their two runners; new tools/test-*.mjs must be listed.
export const TEST_SUITES = [
  { f: "test-security.mjs", offline: true },
  { f: "test-deploy-assets.mjs", offline: true },
  { f: "test-desktop.mjs", offline: true },
  { f: "test-export.mjs", offline: true },
  { f: "test-sources-index.mjs", offline: true },
  { f: "test-searchapi.mjs", offline: true },
  { f: "test-store.mjs", offline: true },
  { f: "test-cert-proficiency.mjs", offline: true },
  { f: "test-requirement-severity.mjs", offline: true },
  { f: "test-filters-intern-degree.mjs", offline: true },
  { f: "test-destinations.mjs", offline: true },
  { f: "verify-package.mjs", offline: true, artifact: true },
  { f: "audit-project.mjs", offline: true },
  { f: "audit-soft-requirements.mjs", offline: true },
  { f: "check-package-json.mjs", offline: true },
  { f: "test-fontmap.mjs", offline: true },
  { f: "test-font-stability.mjs", offline: true },
  // These adapters perform real network requests and never enter offline CI.
  { f: "test-campus.mjs", offline: false },
  { f: "test-profile-pin.mjs", offline: false },
  { f: "test-university-registry.mjs", offline: false },
  { f: "test-fire-safety-profile.mjs", offline: false },
  { f: "test-chenyun.mjs", offline: false },
  { f: "test-jiuyeqiao.mjs", offline: false },
];

export const EXCLUDED_TEST_ENTRIES = [
  {
    f: "test-v2.mjs",
    mode: "aggregate",
    reason: "聚合入口单独调用；递归自动发现 tests/**/*.test.mjs",
  },
  {
    f: "test-ui.mjs",
    mode: "aggregate",
    reason: "聚合入口单独调用；自动发现 tests/ui/*.test.tsx",
  },
  {
    f: "test-web.mjs",
    mode: "manual",
    reason: "需要已启动服务，执行真实检索及可计费模型调用，保留独立手动入口",
  },
  {
    f: "test-collection-electron.mjs",
    mode: "native",
    reason: "独立 Electron 原生合成验收，需要可启动的本机桌面运行时",
  },
  {
    f: "test-collection-worker-runtime.mjs",
    mode: "native",
    reason: "独立采集 worker 验收，需要已验证的 Python 与浏览器运行时",
  },
  {
    f: "test-bundled-runtime.mjs",
    mode: "native",
    reason: "依赖已打包发行资源的独立诊断，正式交付另须 packaged self-test",
  },
];

export function assertTestRegistration({
  files,
  suites = TEST_SUITES,
  exclusions = EXCLUDED_TEST_ENTRIES,
}) {
  const entries = [...suites, ...exclusions].filter((entry) =>
    /^test-.*\.mjs$/.test(entry.f),
  );
  const names = entries.map((entry) => entry.f);
  const duplicates = [
    ...new Set(names.filter((name, index) => names.indexOf(name) !== index)),
  ];
  if (duplicates.length)
    throw Error("Duplicate test registration: " + duplicates.join(", "));
  const missing = names.filter((name) => !files.includes(name));
  if (missing.length)
    throw Error("Missing registered test entries: " + missing.join(", "));
  const unregistered = files.filter((name) => !names.includes(name));
  if (unregistered.length)
    throw Error("Unregistered test entries: " + unregistered.join(", "));
  for (const entry of exclusions)
    if (
      !entry.reason ||
      !["aggregate", "native", "manual"].includes(entry.mode)
    )
      throw Error("Invalid test exclusion: " + entry.f);
  return {
    registered: entries.length - exclusions.length,
    excluded: exclusions.length,
  };
}
