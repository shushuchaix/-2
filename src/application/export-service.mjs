import { createJobService } from "./job-service.mjs";
import { assertInput } from "../../public/js/validation-rules.js";
import { redactBusiness, csvCell } from "../domain/redact.mjs";
import { packageError } from "../domain/packages.mjs";
import { readOwnedTarget } from './job-row-access.mjs';
const jobHeadToken = result => JSON.stringify([result.head, result.controlDeletionHead]);
export function createExportService({ repository }) {
  return {
    async export({ format = "json", filters = {}, scope } = {}) {
      const schemaVersion = await repository.getMeta('schemaVersion');
      const revision = schemaVersion === 3 ? null : await repository.getMeta('revision'), asOf = new Date(repository.clock.now()).toISOString();
      let jobHead;
      if (schemaVersion === 3) {
        const selected = scope || filters;
        if (selected.allTargets === true) {
          if (
            selected.packageId ||
            selected.targetRevisionId ||
            filters.packageId ||
            filters.targetRevisionId
          )
            throw packageError(
              "package_scope_mismatch",
              "全部目标与具体版本范围不能同时导出。",
            );
          filters = { ...filters, allTargets: true };
        } else {
          if (filters.allTargets)
            throw packageError(
              "package_scope_mismatch",
              "导出范围与筛选条件不一致。",
            );
          await readOwnedTarget(repository, selected, repository.clock.now());
          filters = {
            ...filters,
            packageId: selected.packageId,
            targetRevisionId: selected.targetRevisionId,
          };
        }
      }
      assertInput("export", { format: format === "markdown" ? "md" : format });
      assertInput("filters", filters);
      if (schemaVersion === 3) jobHead = jobHeadToken(await repository.readJobHead(filters.allTargets ? { allTargets: true } : { ownerPackageId: filters.packageId }, { scope: filters.allTargets ? undefined : filters }));
      if (format === "md") format = "markdown";
      const service = createJobService({ repository });
      const result = await service.queryJobs({
        ...filters,
        ...(schemaVersion === 3 ? { asOf } : {}),
        page: 1,
        pageSize: 200,
      });
      const items = [...result.items];
      for (let page = 2; items.length < result.total; page++) {
        const next = await service.queryJobs({
          ...filters,
          ...(schemaVersion === 3 ? { asOf } : {}),
          page,
          pageSize: 200,
        });
        if (!next.items.length) break;
        items.push(...next.items);
      }
      if (
        !Object.keys(filters).some(
          (k) =>
            ![
              "status",
              "applicationStatus",
              "search",
              "page",
              "pageSize",
              "packageId",
              "targetRevisionId",
              "allTargets",
              "asOf",
            ].includes(k) &&
            filters[k] &&
            filters[k] !== "all",
        )
      ) {
        const unresolvedItems=[];
        for(let page=1;;page++){
          const unresolved=await service.listUnresolvedApplications({...filters,page,pageSize:200});
          unresolvedItems.push(...unresolved.items);
          if(!unresolved.hasMore || !unresolved.items.length)break;
        }
        items.push(
          ...unresolvedItems.map(({ application, candidateJobs }) => ({
            jobId: application.jobId,
            title: "待确认旧记录",
            company: null,
            cities: [],
            sourceId: "legacy",
            url: null,
            salary: null,
            application,
            evaluation: null,
            unresolved: true,
            candidateJobIds: candidateJobs.map((j) => j.jobId),
          })),
        );
      }
      const rows = redactBusiness(items);
      const changed = schemaVersion === 3 ? jobHeadToken(await repository.readJobHead(filters.allTargets ? { allTargets: true } : { ownerPackageId: filters.packageId }, { scope: filters.allTargets ? undefined : filters })) !== jobHead : await repository.getMeta('revision') !== revision;
      if (changed) throw packageError('export_changed', '导出期间岗位已变化，请重新导出。');
      if (format === "json")
        return {
          filename: "jobs.json",
          contentType: "application/json; charset=utf-8",
          body: JSON.stringify(rows, null, 2),
        };
      const header = [
        "岗位ID",
        "岗位",
        "公司",
        "城市",
        "薪资原文",
        "来源",
        "链接",
        "状态",
        "备注",
        "资格",
        "匹配分",
        "投递日期",
        "跟进日期",
        "简历版本",
        "待确认候选岗位",
        "招聘时效",
        "正文证据",
        "投递入口证据",
      ];
      const values = rows.map((i) => [
        i.jobId,
        i.title,
        i.company,
        i.cities.join(" / "),
        typeof i.salary === "object" ? i.salary?.raw : i.salary,
        i.sourceId,
        i.url,
        {
          new: "未处理",
          seen: "已看过",
          interested: "感兴趣",
          applied: "已投递",
          interviewing: "面试中",
          offer: "已录用",
          rejected: "未通过",
          ignored: "已忽略",
        }[i.application.status] || i.application.status,
        i.application.note,
        i.evaluation?.qualification?.status,
        i.evaluation?.score,
        i.application.appliedAt,
        i.application.followUpAt,
        i.application.resumeRevisionId,
        i.candidateJobIds?.join(" / "),
        i.recruitmentEvidence?.openingStatus ?? "unknown",
        i.recruitmentEvidence?.bodyVerified ? "verified" : "unknown",
        i.recruitmentEvidence?.applicationStatus ?? "unknown",
      ]);
      if (format === "csv")
        return {
          filename: "jobs.csv",
          contentType: "text/csv; charset=utf-8",
          body:
            "\uFEFF" +
            [header, ...values]
              .map((r) => r.map(csvCell).join(","))
              .join("\r\n"),
        };
      if (format === "markdown")
        return {
          filename: "jobs.md",
          contentType: "text/markdown; charset=utf-8",
          body: [header, header.map(() => "---"), ...values]
            .map(
              (r) =>
                "| " +
                r
                  .map((v) =>
                    String(v ?? "")
                      .replace(/\|/g, "\\|")
                      .replace(/[\r\n]/g, " "),
                  )
                  .join(" | ") +
                " |",
            )
            .join("\n"),
        };
      throw Error("Unsupported export format");
    },
  };
}
