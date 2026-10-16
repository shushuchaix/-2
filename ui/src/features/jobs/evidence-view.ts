import { safeExternalUrl } from "../../../../public/js/format.js";
import { factOf, qualificationOf, type JobItem } from "./job-view";

export type EvidenceView = {
  items: {
    key: "body" | "opening" | "application" | "qualification";
    label: string;
    state: "verified" | "unknown" | "unavailable";
    reason: string | null;
  }[];
  conflicts: string[];
  entryLabel: "前往投递" | "查看入口（待核验）" | "打开沟通入口" | null;
  entryUrl: string | null;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function evidenceView(row: JobItem): EvidenceView {
  const fact = factOf(row);
  const evidence = row.recruitmentEvidence || {};
  const platformEntry = object(object(fact.platformEvidence).entry);
  const communication = platformEntry.kind === "communication";
  const opening = evidence.openingStatus;
  const application = evidence.applicationStatus;
  const qualification = row.evaluation?.qualification?.status;
  const openingReasons: Record<string, string> = {
    open: "当前招聘",
    closed: "已截止",
    expired: "已过期",
    historical: "历史结果公告",
  };
  const applicationReasons: Record<string, string> = {
    available: "投递入口已核验",
    login_required: "投递入口需登录后核验",
    unavailable: "投递入口不可用",
    invalid: "入口失效",
  };
  const invalidEntry =
    ["invalid", "unavailable"].includes(application || "") ||
    ["invalid", "unavailable"].includes(String(platformEntry.status || ""));
  const candidate = communication
    ? (platformEntry.url ?? fact.communicationUrl ?? fact.applyUrl ?? fact.url)
    : (platformEntry.url ?? fact.applyUrl);
  const entryUrl = invalidEntry ? null : safeExternalUrl(candidate);
  const entryLabel = !entryUrl
    ? null
    : communication
      ? "打开沟通入口"
      : application === "available"
        ? "前往投递"
        : "查看入口（待核验）";
  return {
    items: [
      {
        key: "body",
        label: "岗位正文",
        state: evidence.bodyVerified === true ? "verified" : "unknown",
        reason: evidence.bodyVerified === true ? "正文已核验" : "正文待补全",
      },
      {
        key: "opening",
        label: "招聘时效",
        state:
          opening === "open"
            ? "verified"
            : ["closed", "expired", "historical"].includes(opening || "")
              ? "unavailable"
              : "unknown",
        reason: openingReasons[opening || ""] || "招聘时效待核验",
      },
      {
        key: "application",
        label: "投递入口",
        state: invalidEntry
          ? "unavailable"
          : communication
            ? "unknown"
            : application === "available"
              ? "verified"
              : "unknown",
        reason: invalidEntry
          ? applicationReasons[application || ""] || "投递入口不可用"
          : communication
            ? "平台沟通入口不构成投递证据。"
            : applicationReasons[application || ""] || "投递入口待核验",
      },
      {
        key: "qualification",
        label: "资格条件",
        state:
          ["pass", "eligible"].includes(qualification || "") ||
          (!qualification && row.evaluation?.qualified === true)
            ? "verified"
            : ["fail", "ineligible"].includes(qualification || "")
              ? "unavailable"
              : "unknown",
        reason:
          !qualification || ["unknown", "likely"].includes(qualification)
            ? row.evaluation?.qualified === true && !qualification
              ? qualificationOf(row)
              : "条件待核验"
            : qualificationOf(row),
      },
    ],
    conflicts: (evidence.conflicts || []).map((value) => {
      if (typeof value === "string") return value;
      const conflict = object(value);
      return (
        String(conflict.field || "条件") +
        (typeof conflict.reason === "string" ? "：" + conflict.reason : "")
      );
    }),
    entryLabel,
    entryUrl,
  };
}
