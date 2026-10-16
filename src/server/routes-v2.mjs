import {
  identifier,
  jobIdentifier,
  filters,
  applicationPatch,
  resumeText,
  userCredentials,
  invalid,
} from "./validation.mjs";
import { writeRunEventStream } from "./event-stream.mjs";
import { handleTrashRequest } from "./trash-routes.mjs";
import {
  handlePackageBusinessRequest,
  businessScope,
} from "./package-business-routes.mjs";
import { handleCollectionRequest } from "./collection-routes.mjs";
import { UUID_RE, packageError } from "../domain/packages.mjs";
import { assertInput, inputError } from "../../public/js/validation-rules.js";
import { extractResumeText } from "../resume/extract-text.mjs";
import { analyzeResumeOffline } from "../resume/offline.mjs";
import { normalizeProfile, analyzeResume } from "../resume/profile.mjs";
import { redactBusiness } from "../domain/redact.mjs";
import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";
import { handleDiagnosticRead } from "./diagnostic-routes.mjs";
const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    invalid("Invalid encoded path");
  }
};
export async function handleV2Request(req, res, context) {
  const url = new URL(req.url, "http://localhost"),
    pathname = url.pathname;
  if (!pathname.startsWith("/api/v2/")) return false;
  if (await handleTrashRequest(req, res, context)) return true;
  if (await handleCollectionRequest(req, res, context)) return true;
  if (await handlePackageBusinessRequest(req, res, context)) return true;
  const route = pathname.slice(7),
    method = req.method;
  const {
    http,
    workspaceService: workspace,
    jobService: jobs,
    runService: runs,
  } = context;
  const send = (status, data) => http.json(req, res, status, data),
    body = () => http.readJson(req);
  let match;
  if (await handleDiagnosticRead(req, res, context)) return true;
  if (route === "/profiles/import-preview" && method === "POST") {
    const input = await body();
    let text = input.resumeText || input.text,
      warnings = [],
      format = "text";
    if (input.base64) {
      let extracted;
      try {
        extracted = await extractResumeText(
          Buffer.from(
            String(input.base64).replace(/^data:[^;]+;base64,/, ""),
            "base64",
          ),
          String(input.filename || "resume.txt"),
        );
      } catch (error) {
        if (error.code === "pdf_no_extractable_text") {
          error.fieldErrors = { file: error.message };
          throw error;
        }
        throw inputError({
          file: "文件读取失败，请确认文件完整、未加密且为支持的简历格式；也可以清除文件后粘贴正文。",
        });
      }
      text = extracted.text;
      warnings = extracted.warnings || [];
      format = extracted.format;
    }
    try {
      text = resumeText(text);
    } catch (error) {
      error.fieldErrors = {
        [input.base64 ? "file" : "resumeText"]: error.message,
      };
      throw error;
    }
    let profile = normalizeProfile(analyzeResumeOffline(text));
    if (input.mode === "ai") {
      const client = context.modelFactory({
        budget: await context.createModelBudget(),
        credentials: userCredentials(input, context.cfg),
        diagnosticContext: { requestId: http.requestId },
      });
      if (client.available)
        try {
          profile = await analyzeResume(client, text);
        } catch (error) {
          const diagnostic = await recordDiagnostic(
            context.diagnostics,
            {
              operation: "model.fallback",
              level: "warn",
              phase: "parse",
              outcome: "partial",
              code: "model_preview_failed",
              requestId: http.requestId,
            },
            error,
          );
          warnings.push(
            "模型提取失败，使用离线预览。" +
              (diagnostic?.diagnosticId
                ? "（错误编号：" + diagnostic.diagnosticId + "）"
                : ""),
          );
        }
      else warnings.push("未配置模型密钥，使用离线预览。");
    }
    send(200, {
      text,
      profile: {
        ...profile,
        education: profile.degree,
        cities: profile.preferredCities,
        explicitFacts: {},
      },
      format,
      warnings,
      inferred: true,
      parserVersion: "preview-2",
    });
    return true;
  }
  if (route === "/profiles") {
    if (method === "GET")
      send(200, { profiles: await workspace.listProfiles() });
    else if (method === "POST") {
      const input = await body();
      if (input.profileId) identifier(input.profileId);
      send(201, await workspace.saveProfile(redactBusiness(input)));
    } else return false;
    return true;
  }
  if (
    (match = route.match(
      /^\/(profiles|targets)\/([^/]+)\/revisions(?:\/([^/]+))?(?:\/(restore|permanent))?$/,
    ))
  ) {
    const kind = match[1] === "profiles" ? "profile" : "target";
    const id = identifier(decode(match[2])),
      revision = match[3] ? decode(match[3]) : null;
    const revisionId = revision
      ? revision.includes("@")
        ? identifier(revision, { revision: true })
        : identifier(id + "@" + revision, { revision: true })
      : null;
    const modern = (await context.repository.read()).schemaVersion === 3;
    const packageId = url.searchParams.get("packageId") || undefined;
    if (modern && revisionId && !UUID_RE.test(packageId || ""))
      throw packageError(
        "package_scope_mismatch",
        "请指定要管理的版本数据包。",
      );
    const args = { kind, parentId: id, revisionId, packageId };
    if (method === "POST" && match[4] === "restore" && revisionId)
      send(
        200,
        await workspace.restoreVersion({
          ...args,
          ...(modern ? { archiveId: (await body()).archiveId } : {}),
        }),
      );
    else if (method === "DELETE" && match[4] === "permanent" && revisionId) {
      if (modern)
        throw inputError({ _form: "请在回收站预览整个版本的永久清理后确认。" });
      send(200, await workspace.permanentlyDeleteVersion(args));
    } else if (match[4]) return false;
    else if (method === "POST" && !revisionId)
      send(
        201,
        await workspace[kind === "profile" ? "saveProfile" : "saveTarget"]({
          ...redactBusiness(await body()),
          [kind + "Id"]: id,
        }),
      );
    else if (method === "GET") {
      const all =
        await workspace[kind === "profile" ? "listProfiles" : "listTargets"]();
      const revisions = all.filter((p) => p[kind + "Id"] === id);
      if (revisionId) {
        const found = revisions.find((p) => p.revisionId === revisionId);
        if (!found && all.some((p) => p.revisionId === revisionId))
          throw Object.assign(
            inputError({ revisionId: "该版本不属于所选项目。" }),
            { code: "version_parent_mismatch" },
          );
        if (!found) invalid("Profile revision not found", 404);
        if (modern && found.packageId !== packageId)
          throw packageError(
            "package_scope_mismatch",
            "所选版本与数据包不一致。",
          );
        send(200, found);
      } else send(200, { revisions });
    } else if (method === "PATCH" && revisionId) {
      const input = await body();
      if (
        Object.keys(input).some((k) => !["versionName", "enabled"].includes(k))
      )
        throw inputError({
          _form: "此接口只修改版本名称或启停状态，请使用新建版本保存配置。",
        });
      send(200, await workspace.updateVersion({ ...args, ...input }));
    } else if (method === "DELETE" && revisionId)
      send(200, await workspace.archiveVersion(args));
    else return false;
    return true;
  }
  if (route === "/targets") {
    if (method === "GET") send(200, { targets: await workspace.listTargets() });
    else if (method === "POST") {
      const input = await body();
      if (input.targetId) identifier(input.targetId);
      send(201, await workspace.saveTarget(input));
    } else return false;
    return true;
  }
  if (
    (match = route.match(/^\/targets\/([^/]+)$/)) &&
    ["PUT", "PATCH"].includes(method)
  ) {
    const id = identifier(decode(match[1])),
      previous = (await workspace.listTargets())
        .filter((t) => t.targetId === id)
        .at(-1);
    if (!previous) invalid("Target not found", 404);
    const input = await body();
    if (method === "PATCH") {
      if (!input.revisionId)
        throw inputError({
          revisionId: "请指定要管理的版本，不能自动修改最新版本。",
        });
      if (
        Object.keys(input).some(
          (k) => !["revisionId", "versionName", "enabled"].includes(k),
        )
      )
        throw inputError({ _form: "管理操作不接受配置修改。" });
      send(
        200,
        await workspace.updateVersion({
          kind: "target",
          parentId: id,
          revisionId: identifier(input.revisionId, { revision: true }),
          versionName: input.versionName,
          enabled: input.enabled,
        }),
      );
      return true;
    }
    if (!input.versionName)
      throw inputError({ versionName: "请为新版本填写不同名称。" });
    if (input.profileRevisionId)
      identifier(input.profileRevisionId, { revision: true });
    send(
      200,
      await workspace.saveTarget(
        { ...previous, ...input, targetId: id },
        {
          submissionInput: { ...input, targetId: id },
        },
      ),
    );
    return true;
  }
  if (route === "/runs") {
    if (method === "GET")
      send(200, {
        runs: await runs.listRuns({
          status: url.searchParams.get("status") || undefined,
          targetId: url.searchParams.get("targetId") || undefined,
        }),
      });
    else if (method === "POST") {
      const input = await body();
      assertInput("run", input);
      send(
        202,
        await runs.startRun({
          targetRevisionId: input.targetRevisionId,
          mode: input.mode || "rules",
          credentials: {
            diagnosticContext: { requestId: http.requestId },
            ...(input.mode === "rules" || !input.mode
              ? {}
              : userCredentials(input, context.cfg)),
            ip: http.ip(req),
          },
        }),
      );
    } else return false;
    return true;
  }
  if ((match = route.match(/^\/runs\/([^/]+)(?:\/(events|cancel))?$/))) {
    const id = identifier(decode(match[1]));
    if (match[2] === "events" && method === "GET") {
      const raw = url.searchParams.get("afterSeq") || "0";
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        invalid("Invalid event cursor");
      await writeRunEventStream({
        req,
        res,
        runId: id,
        afterSeq: Number(raw),
        eventHub: context.eventHub,
      });
    } else if (match[2] === "cancel" && method === "POST")
      send(200, await runs.cancelRun(id));
    else if (!match[2] && method === "GET") send(200, await runs.getRun(id));
    else return false;
    return true;
  }
  if (route === "/jobs/duplicates/preview" && method === "POST") {
    send(200, await context.jobCleanupService.preview());
    return true;
  }
  if (route === "/jobs/duplicates/apply" && method === "POST") {
    const input = await body();
    send(
      200,
      await context.jobCleanupService.apply({
        workspaceRevision: input.workspaceRevision,
        planHash: input.planHash,
        selectedGroupIds: input.selectedGroupIds,
      }),
    );
    return true;
  }
  if (route === "/jobs/evaluations" && method === "POST") {
    const input = await body();
    identifier(input.profileRevisionId, { revision: true });
    identifier(input.targetRevisionId, { revision: true });
    if (!Array.isArray(input.jobIds) || input.jobIds.length > 5000)
      invalid("Invalid job ids (maximum5000)");
    input.jobIds.forEach(jobIdentifier);
    const credentials = userCredentials(input, context.cfg),
      client = ["ai", "auto"].includes(input.mode)
        ? context.modelFactory({
            credentials,
            budget: await context.createModelBudget(),
            diagnosticContext: { requestId: http.requestId },
          })
        : undefined;
    send(
      200,
      await context.evaluationService.rescore({
        ...input,
        mode: input.mode || "rules",
        modelClient: client,
      }),
    );
    return true;
  }
  if (route === "/jobs" && method === "GET") {
    send(200, await jobs.queryJobs(filters(url.searchParams)));
    return true;
  }
  if (
    (match = route.match(
      /^\/jobs\/([^/]+)(?:\/(evaluations|application|links))?$/,
    ))
  ) {
    const id = jobIdentifier(decode(match[1]));
    if (!match[2] && method === "GET") {
      const targetRevisionId = url.searchParams.get("targetRevisionId");
      if (targetRevisionId) identifier(targetRevisionId, { revision: true });
      send(200, await jobs.getJob(id, { targetRevisionId }));
    } else if (match[2] === "application" && ["POST", "PUT"].includes(method))
      send(
        200,
        await jobs.updateApplication(id, applicationPatch(await body())),
      );
    else if (match[2] === "evaluations" && method === "POST") {
      const input = await body();
      identifier(input.profileRevisionId, { revision: true });
      identifier(input.targetRevisionId, { revision: true });
      const credentials = userCredentials(input, context.cfg),
        client =
          input.mode === "ai"
            ? context.modelFactory({
                credentials,
                budget: await context.createModelBudget(),
                diagnosticContext: { requestId: http.requestId },
              })
            : undefined;
      send(
        200,
        await context.evaluationService.rescore({
          jobIds: [id],
          profileRevisionId: input.profileRevisionId,
          targetRevisionId: input.targetRevisionId,
          mode: input.mode || "rules",
          modelClient: client,
        }),
      );
    } else if (match[2] === "links" && ["POST", "DELETE"].includes(method)) {
      const input = await body(),
        other = assertInput("link", input, { selfId: id }).jobId;
      send(
        200,
        await (method === "POST"
          ? jobs.linkJobs(id, other)
          : jobs.unlinkJobs(id, other)),
      );
    } else return false;
    return true;
  }
  if (route === "/applications/unresolved" && method === "GET") {
    send(200, await jobs.listUnresolvedApplications(filters(url.searchParams)));
    return true;
  }
  if ((match = route.match(/^\/applications\/([^/]+)$/)) && method === "GET") {
    send(200, await jobs.getApplication(jobIdentifier(decode(match[1]))));
    return true;
  }
  if ((match = route.match(/^\/applications\/([^/]+)$/)) && method === "PUT") {
    send(
      200,
      await jobs.updateApplication(
        jobIdentifier(decode(match[1])),
        applicationPatch(await body()),
      ),
    );
    return true;
  }
  if (route === "/sources" && method === "GET") {
    const params = Object.fromEntries(url.searchParams);
    send(200, {
      sources:
        params.packageId || params.targetRevisionId
          ? await context.sourceService.listScopedSources({
              scope: businessScope(params),
            })
          : await context.sourceService.listSources(),
      sites: await context.getCatalog(),
    });
    return true;
  }
  if (route === "/sources/sites" && method === "POST") {
    const input = await body();
    assertInput("site", input);
    send(201, await context.sourceService.addSite(input));
    return true;
  }
  if (
    (match = route.match(/^\/sources\/sites\/([^/]+)$/)) &&
    method === "DELETE"
  ) {
    send(
      200,
      await context.sourceService.removeSite(identifier(decode(match[1]))),
    );
    return true;
  }
  if (
    (match = route.match(/^\/sources\/([^/]+)\/(probe|settings)$/)) &&
    ["POST", "PUT"].includes(method)
  ) {
    const id = identifier(decode(match[1])),
      input = await body();
    if (input.siteId) identifier(input.siteId);
    if (input.scope || input.packageId || input.targetRevisionId) {
      const scope = businessScope(input);
      send(
        200,
        match[2] === "probe"
          ? await context.sourceService.probeScopedSource({
              scope,
              sourceId: id,
              siteId: input.siteId,
              ref: input.activityId
                ? { scope, activityId: identifier(input.activityId) }
                : undefined,
            })
          : await context.sourceService.saveScopedConfig({
              scope,
              sourceId: id,
              config: input.config || {},
            }),
      );
      return true;
    }
    send(
      200,
      match[2] === "probe"
        ? await context.sourceService.probe(id, input.siteId)
        : await context.sourceService.saveSourceConfig({
            sourceId: id,
            config: input.config || input,
          }),
    );
    return true;
  }
  if (
    (match = route.match(/^\/sources\/([^/]+)\/service$/)) &&
    method === "POST"
  ) {
    const input = await body();
    send(
      200,
      await context.sourceService.enableOptionalReadService({
        scope: businessScope(input),
        serviceId: identifier(decode(match[1])),
        proofId: identifier(input.proofId),
        paidServiceAcknowledged: input.paidServiceAcknowledged === true,
      }),
    );
    return true;
  }
  if (route === "/settings") {
    if (method === "GET") send(200, await context.getSettings());
    else if (["POST", "PUT"].includes(method))
      send(200, await context.saveSettings(await body()));
    else return false;
    return true;
  }
  if (route === "/imports" && method === "POST") {
    send(201, await context.importService.import(await body()));
    return true;
  }
  if (route === "/exports" && ["POST", "GET"].includes(method)) {
    const input =
        method === "POST"
          ? await body()
          : {
              format: url.searchParams.get("format") || "json",
              filters: filters(url.searchParams),
            },
      result = await context.exportService.export(input);
    res.writeHead(200, {
      "Content-Type": result.contentType,
      "Content-Disposition": 'attachment; filename="' + result.filename + '"',
      "Cache-Control": "no-store",
    });
    res.end(result.body);
    return true;
  }
  if (route === "/workspace/backup" && ["POST", "GET"].includes(method)) {
    send(200, await context.backup());
    return true;
  }
  if (route === "/workspace/restore" && method === "POST") {
    send(200, await context.restore((await body()).archive));
    return true;
  }
  return false;
}
