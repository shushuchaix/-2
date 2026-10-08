export type ApplicationRecord = {
  applicationId?: string;
  jobId?: string;
  status: string;
  note?: string;
  channel?: string;
  appliedAt?: string;
  followUpAt?: string;
  resumeRevisionId?: string;
  events?: Record<string, unknown>[];
};
export type JobFact = {
  jobId?: string;
  title?: string;
  organization?: string;
  company?: string;
  cities?: string[];
  deadline?: string;
  url?: string;
  description?: string;
  requirements?: unknown;
  kind?: string;
  [key: string]: unknown;
};
export type JobItem = JobFact & {
  jobId: string;
  ownerPackageId?: string;
  packageId?: string;
  targetRevisionId?: string;
  versionName?: string;
  job?: JobFact & { canonical?: JobFact };
  fact?: {
    fields?: JobFact;
    record?: JobFact;
    status?: string;
    [key: string]: unknown;
  };
  application?: ApplicationRecord;
  evaluation?: {
    score?: number;
    recommendation?: string;
    qualified?: boolean;
    qualification?: { status?: string; [key: string]: unknown };
    reasons?: unknown;
    [key: string]: unknown;
  };
  sources?: { sourceId?: string; name?: string; url?: string }[];
  observations?: Record<string, unknown>[];
  evaluations?: Record<string, unknown>[];
};
export const applicationLabels: Record<string, string> = {
  new: "未处理",
  seen: "已查看",
  interested: "感兴趣",
  applied: "已投递",
  interviewing: "面试中",
  offer: "已录用",
  rejected: "未通过",
  ignored: "已忽略",
};
export function factOf(row: JobItem): JobFact {
  const fact = {
    ...row,
    ...row.job,
    ...row.job?.canonical,
    ...row.fact?.record,
    ...row.fact?.fields,
  };
  return {
    ...fact,
    deadline:
      fact.deadline ??
      (typeof fact.deadlineAt === "string" ? fact.deadlineAt : undefined),
  };
}
export function qualificationOf(row: JobItem) {
  const status = row.evaluation?.qualification?.status;
  return status
    ? ((
        {
          pass: "符合已知要求",
          fail: "不符合明确要求",
          eligible: "符合資格",
          ineligible: "资格不符",
          unknown: "待核实",
          likely: "基本符合",
        } as Record<string, string>
      )[status] ?? status)
    : row.evaluation?.qualified === true
      ? "符合已知要求"
      : "待核实";
}
export function recommendationOf(row: JobItem) {
  return (
    (
      {
        high: "优先推荐",
        consider: "可以考虑",
        low: "匹配较低",
        insufficient: "信息不足",
        not_recommended: "不推荐",
        recommended: "推荐",
      } as Record<string, string>
    )[row.evaluation?.recommendation ?? ""] ?? "尚未评价"
  );
}
