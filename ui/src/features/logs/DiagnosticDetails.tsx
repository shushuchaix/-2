import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "../../components/ui/sheet";
import { RecordCounts } from "../../components/RecordCounts";
import { Button } from "../../components/ui/button";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "../../components/ui/collapsible";

export type DiagnosticEntry = Record<string, unknown>;
const operationLabels: Record<string, string> = {
  network: "网络请求",
  source: "来源采集",
  collection: "采集活动",
  model: "模型调用",
  storage: "数据保存",
  http: "操作请求",
  application: "工作区操作",
  desktop: "桌面界面",
  parser: "内容解析",
  parse: "内容解析",
  import: "数据导入",
  run: "检索任务",
  workspace: "工作区操作",
};
export const diagnosticOperationLabel = (value: unknown) =>
  typeof value === "string"
    ? operationLabels[value.split(".")[0]] || "其他诊断事件"
    : "诊断事件";
export const diagnosticLevelLabel = (value: unknown) =>
  (
    ({ error: "错误", warn: "提醒", info: "信息", debug: "调试" }) as Record<
      string,
      string
    >
  )[String(value)] || "级别未提供";
export const diagnosticResultLabel = (value: unknown) =>
  (
    ({
      ETIMEDOUT: "请求超时",
      ESOCKETTIMEDOUT: "请求超时",
      ECONNREFUSED: "连接被拒绝",
      ECONNRESET: "连接中断",
      ENOTFOUND: "域名无法解析",
      EAI_AGAIN: "域名解析暂不可用",
    }) as Record<string, string>
  )[String(value)] || (value ? "需要查看技术详情" : "过程记录");
const resultCategoryLabels: Record<string, string> = {
  response: "已收到响应",
  success: "业务成功",
  network: "网络异常",
  timeout: "超时",
  cancelled: "已取消",
  policy: "被访问策略阻止",
  budget: "达到预算上限",
  response_unobserved: "未观察到完整响应",
  business_risk: "平台风险限制",
  auth: "需要登录或会话已失效",
  rate_limited: "平台限流",
  unknown: "原因尚未确认",
};
const requestPurposeLabels: Record<string, string> = {
  login: "登录流程",
  login_poll: "登录状态轮询",
  list: "岗位列表",
  detail: "岗位详情",
  document: "页面文档",
  asset: "静态资源",
  other: "其他请求",
};
const enumLabel = (labels: Record<string, string>, value: unknown) =>
  typeof value === "string" && Object.hasOwn(labels, value)
    ? labels[value]
    : undefined;
export const diagnosticResultCategoryLabel = (value: unknown) =>
  enumLabel(resultCategoryLabels, value);
function diagnosticPhaseLabel(entry: DiagnosticEntry) {
  if (
    entry.phase === "parse" &&
    object(entry.parser) &&
    entry.parser.version === "boss-business-response"
  )
    return "业务响应判定";
  return (
    enumLabel(
      {
        started: "请求开始",
        finished: "处理结束",
        validation: "请求检查",
        queue: "请求排队",
        dns: "域名解析",
        budget: "预算检查",
        transport: "网络传输",
        response: "收到网络响应",
        redirect: "页面跳转",
        retry: "等待重试",
        parse: "内容解析",
        cleanup: "资源清理",
        load: "页面加载",
        commit: "保存结果",
      },
      entry.phase,
    ) || "其他处理阶段"
  );
}
const numberKeys = new Set([
  "httpStatus",
  "retryCount",
  "retryDelayMs",
  "attempt",
  "recordCount",
  "responseBytes",
  "durationMs",
  "queueMs",
  "dnsMs",
  "transportMs",
  "timeoutMs",
  "page",
  "queryIndex",
  "redirectCount",
  "issueCount",
  "revision",
  "exitCode",
  "maxRetries",
  "pageLimit",
  "batchSize",
  "errorNumber",
]);
const tokenKeys = new Set([
  "operation",
  "level",
  "code",
  "category",
  "phase",
  "failurePhase",
  "stage",
  "outcome",
  "method",
  "sourceId",
  "siteId",
  "endpointKind",
  "dnsResolver",
  "truncationReason",
]);
const numericChildren = new Set([
  "raw",
  "normalized",
  "notices",
  "expanded",
  "deduplicated",
  "eligible",
  "shortlisted",
  "qualificationUnknown",
  "qualificationFailed",
  "aiSuccess",
  "fallback",
  "newForTarget",
  "input",
  "accepted",
  "rejected",
  "pages",
  "plannedSites",
  "skippedSites",
  "queries",
  "cached",
  "invalid",
  "missing",
  "valid",
  "noJob",
  "skipped",
  "failed",
  "complete",
  "interrupted",
  "orphan",
  "issues",
  "profiles",
  "targets",
  "jobs",
  "observations",
  "evaluations",
  "runs",
  "applications",
  "events",
  "files",
  "requests",
  "maxRequests",
  "details",
  "maxDetails",
  "modelRequests",
  "maxModelRequests",
  "attempts",
  "reservedTokens",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "usedCostCny",
  "maxCostCny",
  "upperCostCny",
  "reservedCostCny",
  "uncertainCostCny",
  "textLength",
  "documentLength",
  "resultCount",
  "expectedCount",
  "maxOutputTokens",
  "calls",
  "failures",
  "pricedRequests",
  "uncertainRequests",
  "costUpperBoundCny",
  "truncated",
  "sites",
  "request",
  "list",
  "detail",
  "search",
  "dns",
  "redirect",
  "retry",
  "duplicate_id",
  "invalid_score",
  "invalid_reasons",
  "invalid_gaps",
  "missing_evidence",
  "invalid_evidence",
  "evidence_not_in_source",
  "unknown_id",
  "missing_result",
  "invalid_results_shape",
]);
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const token = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.@-]{1,160}$/.test(v);
function numericTree(
  v: unknown,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!object(v) || depth > 3) return;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    if (
      numericChildren.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    )
      out[key] = value;
    else if (
      [
        "sources",
        "model",
        "counts",
        "usage",
        "coverage",
        "validationCounts",
        "byKind",
      ].includes(key)
    ) {
      const child = numericTree(value, depth + 1);
      if (child && Object.keys(child).length) out[key] = child;
    } else if (key === "costMode" && value === "cny_upper_bound")
      out[key] = value;
    else if (
      key === "pricingVersion" &&
      value === "deepseek-v4.1-flash-cny-2026-10-07"
    )
      out[key] = value;
  }
  return out;
}

/** Explicit display allowlist; never stringify arbitrary diagnostic payloads. */
export function safeDiagnostic(entry: DiagnosticEntry): DiagnosticEntry {
  const result: DiagnosticEntry = {};
  for (const [key, value] of Object.entries(entry)) {
    if (
      numberKeys.has(key) &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      result[key] = value;
    else if (key === "resultCategory" && enumLabel(resultCategoryLabels, value))
      result[key] = value;
    else if (key === "requestPurpose" && enumLabel(requestPurposeLabels, value))
      result[key] = value;
    else if (tokenKeys.has(key) && token(value)) result[key] = value;
    else if (
      [
        "diagnosticId",
        "requestId",
        "parentRequestId",
        "parentDiagnosticId",
        "sessionId",
        "runId",
        "jobId",
        "operationId",
      ].includes(key) &&
      token(value)
    )
      result[key] = value;
    else if (
      key === "at" &&
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(value) &&
      Number.isFinite(Date.parse(value))
    )
      result[key] = value;
    else if (
      key === "route" &&
      typeof value === "string" &&
      /^\/api\/(?:v2\/)?[A-Za-z/:_-]+$/.test(value)
    )
      result[key] = value;
    else if (
      key === "resource" &&
      typeof value === "string" &&
      [
        "workspace.v2.json",
        "workspace.v2.previous.json",
        "config.json",
        "runs-v2/*.json",
        "backups/*.json",
        ".workspace.lock",
      ].includes(value)
    )
      result[key] = value;
    else if (
      ["cacheHit", "hasMore"].includes(key) &&
      typeof value === "boolean"
    )
      result[key] = value;
    else if (["counts", "coverage", "usage"].includes(key))
      result[key] = numericTree(value);
    else if (key === "parser" && object(value)) {
      const p = numericTree(value) || {};
      if (
        typeof value.format === "string" &&
        ["json", "html", "pdf", "docx", "text"].includes(value.format)
      )
        p.format = value.format;
      for (const boolean of ["selectorPresent", "titleOnly"])
        if (typeof value[boolean] === "boolean") p[boolean] = value[boolean];
      if (token(value.version)) p.version = value.version;
      if (
        typeof value.resultType === "string" &&
        [
          "object",
          "array",
          "null",
          "string",
          "number",
          "boolean",
          "unknown",
        ].includes(value.resultType)
      )
        p.resultType = value.resultType;
      if (Array.isArray(value.missingFields))
        p.missingFields = value.missingFields.filter(
          (field) =>
            typeof field === "string" &&
            [
              "data",
              "list",
              "description",
              "title",
              "url",
              "sourceId",
              "records",
              "count",
              "id",
            ].includes(field),
        );
      result.parser = p;
    } else if (key === "runtime" && object(value)) {
      const r: DiagnosticEntry = {};
      for (const version of [
        "appVersion",
        "nodeVersion",
        "electronVersion",
        "chromeVersion",
        "osRelease",
      ])
        if (
          typeof value[version] === "string" &&
          /^v?\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?$/.test(value[version])
        )
          r[version] = value[version];
      if (
        typeof value.platform === "string" &&
        ["win32", "linux", "darwin"].includes(value.platform)
      )
        r.platform = value.platform;
      if (
        typeof value.arch === "string" &&
        ["x64", "arm64", "ia32"].includes(value.arch)
      )
        r.arch = value.arch;
      if (typeof value.packaged === "boolean") r.packaged = value.packaged;
      if (
        typeof value.buildId === "string" &&
        /^[a-f0-9]{40}$/.test(value.buildId)
      )
        r.buildId = value.buildId;
      result.runtime = r;
    } else if (key === "error" && object(value)) {
      const e: DiagnosticEntry = {};
      if (token(value.code)) e.code = value.code;
      if (
        typeof value.name === "string" &&
        [
          "Error",
          "TypeError",
          "RangeError",
          "SyntaxError",
          "AbortError",
          "TimeoutError",
        ].includes(value.name)
      )
        e.name = value.name;
      const frames =
        typeof value.stack === "string"
          ? value.stack
              .split("\n")
              .flatMap((line) => {
                const match = line
                  .replaceAll("\\", "/")
                  .match(
                    /(?:src|electron|public\/js)\/[A-Za-z0-9_./-]+:\d+:\d+|node:[A-Za-z0-9_./-]+:\d+:\d+/,
                  );
                return match ? ["at " + match[0]] : [];
              })
              .slice(0, 16)
          : [];
      if (frames.length) e.stack = frames.join("\n");
      if (object(value.cause) && token(value.cause.code))
        e.cause = { code: value.cause.code };
      result.error = e;
    }
  }
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined),
  );
}

export function DiagnosticDetails({
  entry,
  entries = [],
  onClose,
}: {
  entry: DiagnosticEntry | null;
  entries?: DiagnosticEntry[];
  onClose(): void;
}) {
  const safe = entry ? safeDiagnostic(entry) : null;
  const related = safe?.requestId
    ? entries
        .map(safeDiagnostic)
        .filter((item) => item.requestId === safe.requestId)
        .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
        .slice(0, 64)
    : [];
  return (
    <Sheet
      open={Boolean(entry)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>诊断详情</SheetTitle>
          <SheetDescription>
            仅显示请求过程、计数、运行环境和匿名编号，不包含私人正文或路径。
          </SheetDescription>
        </SheetHeader>
        {safe && (
          <div className="flex flex-col gap-4 p-4">
            <section aria-label="诊断事件摘要" className="flex flex-col gap-3">
              <dl className="grid grid-cols-2 gap-3">
                {[
                  ["操作", diagnosticOperationLabel(safe.operation)],
                  ["级别", diagnosticLevelLabel(safe.level)],
                  ["时间", safe.at],
                  [
                    "结果",
                    diagnosticResultCategoryLabel(safe.resultCategory) ||
                      diagnosticResultLabel(safe.code),
                  ],
                  [
                    "请求用途",
                    enumLabel(requestPurposeLabels, safe.requestPurpose),
                  ],
                  ["处理阶段", diagnosticPhaseLabel(safe)],
                  ["实际耗时（毫秒）", safe.durationMs],
                  ["配置超时（毫秒）", safe.timeoutMs],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <dt className="text-sm text-muted-foreground">
                      {String(label)}
                    </dt>
                    <dd className="break-words">
                      {value === undefined ? "未提供" : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
              {object(safe.counts) && (
                <RecordCounts
                  counts={safe.counts}
                  kind="run"
                  label="诊断计数"
                />
              )}
            </section>
            {related.length > 0 && (
              <section
                aria-label="同一请求过程"
                className="flex flex-col gap-3"
              >
                <h3>同一请求过程</h3>
                <p className="text-sm text-muted-foreground">
                  仅关联当前列表中相同请求编号的记录；HTTP 成功不代表业务成功。
                </p>
                <ol className="flex flex-col gap-3">
                  {related.map((item, index) => (
                    <li
                      key={String(item.diagnosticId || index)}
                      className="flex flex-col gap-1"
                    >
                      <p>
                        {diagnosticPhaseLabel(item)} ·{" "}
                        {diagnosticResultCategoryLabel(item.resultCategory) ||
                          "过程记录"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {enumLabel(requestPurposeLabels, item.requestPurpose) ||
                          "用途未提供"}
                        {typeof item.httpStatus === "number" &&
                          ` · HTTP ${item.httpStatus}`}
                        {typeof item.durationMs === "number" &&
                          ` · 实际耗时 ${item.durationMs} 毫秒`}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            <Collapsible>
              <CollapsibleTrigger render={<Button variant="outline" />}>
                技术详情
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="whitespace-pre-wrap break-all py-3">
                  {JSON.stringify(safe, null, 2)}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
