import { randomUUID } from "node:crypto";
import {assertScope} from '../domain/packages.mjs';
import { createWorkspaceOperationGate } from "./workspace-operations.mjs";
import { assertInput, inputError } from "../../public/js/validation-rules.js";
import { parseHTML } from "linkedom";
import { validatePublicUrl } from "../infrastructure/http/public-url.mjs";
import { htmlToText } from "../util/html.mjs";
import { baseRecord } from "../sources/adapters/shared.mjs";
function platform(url) {
  const host = url?.hostname || "";
  return host === "mp.weixin.qq.com"
    ? "wechat"
    : host === "weibo.com" ||
        host.endsWith(".weibo.com") ||
        host === "weibo.cn" ||
        host.endsWith(".weibo.cn")
      ? "weibo"
      : host === "douyin.com" || host.endsWith(".douyin.com")
        ? "douyin"
        : "web";
}
export function createImportService({
  repository,
  jobService,
  request,
  clock = repository.clock,
  operationGate = createWorkspaceOperationGate({ repository }),
}) {
  return {
    async import(input, { scope, operationLease: parentLease, signal } = {}) {
      const initial=await repository.read();if(initial.schemaVersion===3){assertScope(initial,scope,clock.now());input={...input,targetRevisionId:scope.targetRevisionId};}
      assertInput("import", input);
      return operationGate.withOperation(
        "import",
        { scope, targetRevisionId: input.targetRevisionId, parentLease, signal },
        async (operationLease) => {
          let url = null;
          try {
            url = input.url ? validatePublicUrl(input.url) : null;
          } catch {
            throw inputError({
              url: "招聘链接需为公开的 HTTP 或 HTTPS 网址，不能包含凭据或内网地址。",
            });
          }
          const network = platform(url);
          let text = String(input.text || "").trim(),
            title = input.title?.trim();
          const issues = [];
          if (!text && url && network !== "web") {
            return {
              jobIds: [],
              issues: [
                {
                  code: "manual_text_required",
                  message:
                    "该社交平台需要粘贴正文或使用获授权接口。链接仅作为来源证据。",
                  platform: network,
                },
              ],
            };
          }
          if (!text && url) {
            const response = await request(url.href, { signal });
            if (response.status !== 200)
              throw Error("Import HTTP " + response.status);
            const { document } = parseHTML(response.text);
            for (const node of document.querySelectorAll(
              "script,style,nav,footer",
            ))
              node.remove();
            title ||=
              document.querySelector("h1")?.textContent.trim() ||
              document.title;
            text = htmlToText(
              document.querySelector("article,main")?.innerHTML ||
                document.body?.innerHTML ||
                "",
            );
          }
          if (!text || text.length > 60000)
            throw inputError({
              text: "未获得有效正文，或正文超过 60000 字符；请检查链接或直接粘贴正文。",
            });
          title ||= text.split(/\r?\n/)[0].slice(0, 200);
          const at = new Date(clock.now()).toISOString();
          const record = baseRecord({
            id: url?.href || randomUUID(),
            sourceRecordIdKind: url ? "hint" : "generated",
            urlKind: "unknown",
            sourceId: "manual",
            siteId: network,
            scope: network,
            kind: "recruitment_notice",
            title,
            url: url?.href || null,
            description: text,
            publishedAt: null,
            platform: network,
            account: String(input.account || ""),
            sourceUrl: url?.href || null,
            retrievedAt: at,
            evidenceLevel: input.text ? "user_provided" : "public_page",
            accessStatus: input.text ? "manual" : "public",
            officialIdentity: "unverified",
            evidence: [
              {
                field: "description",
                source: input.text ? "user_provided" : "public_page",
                url: url?.href || null,
              },
            ],
          });
          const runId="import-"+randomUUID();
          if(initial.schemaVersion===3)await repository.mutateWorkspace(w=>{assertScope(w,scope,clock.now());w.runs[runId]={runId,recordId:randomUUID(),ownerPackageId:scope.packageId,targetSnapshot:structuredClone(Object.values(w.targets).flat().find(t=>t.revisionId===scope.targetRevisionId)),status:'completed',stage:'manual_import',events:[],lastSeq:0};},{operationLease});
          const result = await jobService.ingestRecords({
            runId,
            scope,
            records: [record],
            observedAt: at,
            targetRevisionId: input.targetRevisionId,
            provenanceOperationId: operationLease.operationId,
          });
          if (Object.hasOwn(input, "note"))
            for (const id of result.jobIds)
              await jobService[initial.schemaVersion===3?'updateJobApplication':'updateApplication'](id, {
                note: String(input.note),
              },scope);
          issues.push({
            code: "notice_requires_verification",
            message: "导入内容保留为招聘公告，具体岗位和账号归属需核实。",
          });
          return { jobIds: result.jobIds, issues };
        },
      );
    },
  };
}
