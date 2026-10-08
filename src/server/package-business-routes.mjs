import {
  identifier,
  jobIdentifier,
  filters as parseFilters,
  applicationPatch,
  userCredentials,
  invalid,
} from "./validation.mjs";
import {
  packageError,
  UUID_RE,
  assertScope,
  assertOwned,
  requirePackage,
} from "../domain/packages.mjs";
import { writeRunEventStream } from "./event-stream.mjs";
import { parseDiagnosticQuery } from "./diagnostic-routes.mjs";
export function businessScope(input, { read = false } = {}) {
  const value = input?.scope || input || {};
  if (value.allTargets === true || value.allTargets === "true") {
    if (!read)
      throw packageError(
        "version_scope_required",
        "全部目标只能只读，请选择具体版本。",
      );
    if (value.packageId || value.targetRevisionId)
      throw packageError(
        "package_scope_mismatch",
        "全部目标与具体版本范围不能同时使用。",
      );
    return { allTargets: true };
  }
  if (!value.packageId || !value.targetRevisionId)
    throw packageError("version_scope_required", "请选择明确的目标版本。");
  if (!UUID_RE.test(value.packageId))
    throw packageError("package_scope_mismatch", "数据包标识无效。");
  identifier(value.targetRevisionId, { revision: true });
  return {
    packageId: value.packageId,
    targetRevisionId: value.targetRevisionId,
  };
}
export async function handlePackageBusinessRequest(req, res, context) {
  const url = new URL(req.url, "http://localhost"),
    route = url.pathname.slice(7),
    method = req.method;
  if (
    !url.pathname.startsWith("/api/v2/") ||
    !/^\/(?:jobs(?:\/.*)?|applications(?:\/.*)?|runs(?:\/.*)?|imports|exports|legacy-records(?:\/.*)?|diagnostics\/logs(?:\/export)?)$/.test(
      route,
    )
  )
    return false;
  if ((await context.repository.read()).schemaVersion !== 3) return false;
  const { http, jobService: jobs, runService: runs } = context,
    send = (status, data) => http.json(req, res, status, data),
    body = () => http.readJson(req),
    params = Object.fromEntries(url.searchParams),
    readScope = () => businessScope(params, { read: true });
  const scope = () => businessScope(params),
    readFilters = () => ({ ...parseFilters(url.searchParams), ...readScope() });
  let match;
  if (
    ["/diagnostics/logs", "/diagnostics/logs/export"].includes(route) &&
    method === "GET"
  ) {
    const selection = readScope(),
      w = await context.repository.read(),
      { exporting, options } = parseDiagnosticQuery(url, { allowScope: true }),
      limit = options.limit;
    if (!selection.allTargets)
      assertScope(w, selection, context.repository.clock.now());
    let runIds = Object.values(w.runs)
      .filter((r) =>
        selection.allTargets
          ? w.packages[r.ownerPackageId]?.state === "active" &&
            w.packages[r.ownerPackageId]?.kind === "target"
          : r.ownerPackageId === selection.packageId,
      )
      .map((r) => r.runId);
    if (params.runId) {
      identifier(params.runId);
      const run = w.runs[params.runId];
      if (!run) throw packageError("run_not_found", "运行记录不存在。", 404);
      requirePackage(w, run.ownerPackageId, {
        now: context.repository.clock.now(),
      });
      if (!selection.allTargets) assertOwned(w, run, selection.packageId);
      runIds = [params.runId];
    }
    if (exporting) {
      const texts =
        selection.allTargets && !params.runId
          ? [await context.diagnostics.exportText(options)]
          : await Promise.all(
              runIds.map((runId) =>
                context.diagnostics.exportText({ ...options, runId }),
              ),
            );
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition":
          'attachment; filename="job-radar-diagnostics.txt"',
        "Cache-Control": "no-store",
      });
      res.end(texts.join("\n") || "当前版本没有运行诊断记录。");
    } else {
      const results =
        selection.allTargets && !params.runId
          ? [await context.diagnostics.list(options)]
          : await Promise.all(
              runIds.map((runId) =>
                context.diagnostics.list({ ...options, runId }),
              ),
            );
      const entries = results
          .flatMap((r) => r.entries)
          .sort((a, b) => String(b.at).localeCompare(String(a.at)))
          .slice(0, limit),
        total = results.reduce(
          (n, r) => n + (r.summary?.total || r.entries.length),
          0,
        );
      send(200, {
        ...(results[0] || {}),
        entries,
        summary: {
          total,
          returned: entries.length,
          truncated: total > entries.length,
          errors: entries.filter((e) => e.level === "error").length,
          warnings: entries.filter((e) => e.level === "warn").length,
        },
        scope: selection,
      });
    }
    return true;
  }
  async function evaluate(input, jobIds) {
    const selected = businessScope(input),
      mode = input.mode || "rules";
    let modelClient;
    if (["ai", "auto"].includes(mode)) {
      const credentials = userCredentials(input, context.cfg),
        budget = await context.createModelBudget();
      modelClient = context.modelFactory({
        credentials,
        budget,
        diagnosticContext: { requestId: http.requestId },
      });
    }
    return context.evaluationService.rescore({
      scope: selected,
      jobIds: jobIds || input.jobIds,
      mode,
      modelClient,
      diagnosticContext: { requestId: http.requestId },
    });
  }
  if (route === "/jobs/duplicates/preview" && method === "POST") {
    send(200, await context.jobCleanupService.preview(await body()));
    return true;
  }
  if (route === "/jobs/duplicates/apply" && method === "POST") {
    send(200, await context.jobCleanupService.apply(await body()));
    return true;
  }
  if (route === "/jobs/evaluations" && method === "POST") {
    const input = await body();
    send(200, await evaluate(input));
    return true;
  }
  if (route === "/jobs" && method === "GET") {
    send(200, await jobs.queryJobs(readFilters()));
    return true;
  }
  if (
    (match = route.match(
      /^\/jobs\/([^/]+)(?:\/(application|evaluations|links))?$/,
    ))
  ) {
    const id = jobIdentifier(decodeURIComponent(match[1]));
    if (!match[2] && method === "GET")
      send(200, await jobs.getJob(id, scope()));
    else if (match[2] === "application" && ["POST", "PUT"].includes(method)) {
      const input = await body();
      send(
        200,
        await jobs.updateJobApplication(
          id,
          applicationPatch(input),
          businessScope(input),
        ),
      );
    } else if (match[2] === "evaluations" && method === "POST") {
      const input = await body();
      send(200, await evaluate(input, [id]));
    } else if (match[2] === "links" && ["POST", "DELETE"].includes(method)) {
      const input = await body();
      send(
        200,
        await (method === "POST"
          ? jobs.linkJobs(id, jobIdentifier(input.jobId), businessScope(input))
          : jobs.unlinkJobs(
              id,
              jobIdentifier(input.jobId),
              businessScope(input),
            )),
      );
    } else return false;
    return true;
  }
  if (route === "/applications" && method === "GET") {
    send(200, await jobs.queryApplications(readFilters()));
    return true;
  }
  if (route === "/applications/unresolved" && method === "GET") {
    send(200, await jobs.listUnresolvedApplications(readFilters()));
    return true;
  }
  if ((match = route.match(/^\/applications\/([^/]+)$/))) {
    const id = identifier(decodeURIComponent(match[1]));
    if (method === "GET") send(200, await jobs.getApplication(id, scope()));
    else if (["POST", "PUT"].includes(method)) {
      const input = await body();
      send(
        200,
        await jobs.updateApplication(
          id,
          applicationPatch(input),
          businessScope(input),
        ),
      );
    } else return false;
    return true;
  }
  if (route === "/runs") {
    if (method === "GET")
      send(200, { runs: await runs.listRuns({ ...params, ...readScope() }) });
    else if (method === "POST") {
      const input = await body(),
        mode = input.mode || "rules";
      send(
        202,
        await runs.startRun({
          scope: businessScope(input),
          mode,
          credentials: {
            diagnosticContext: { requestId: http.requestId },
            ...(mode === "rules" ? {} : userCredentials(input, context.cfg)),
          },
        }),
      );
    } else return false;
    return true;
  }
  if ((match = route.match(/^\/runs\/([^/]+)(?:\/(events|cancel))?$/))) {
    const id = identifier(decodeURIComponent(match[1]));
    if (match[2] === "events" && method === "GET") {
      const raw = params.afterSeq || "0";
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        invalid("Invalid event cursor");
      const selected = scope();
      await writeRunEventStream({
        req,
        res,
        runId: id,
        afterSeq: Number(raw),
        eventHub: {
          subscribe: (runId, options) =>
            context.eventHub.subscribe(runId, {
              ...options,
              scope: selected,
              onClose: () => res.end(),
            }),
        },
      });
    } else if (match[2] === "cancel" && method === "POST") {
      const input = await body();
      send(200, await runs.cancelRun(id, businessScope(input)));
    } else if (!match[2] && method === "GET")
      send(200, await runs.getRun(id, scope()));
    else return false;
    return true;
  }
  if (route === "/imports" && method === "POST") {
    const input = await body();
    send(
      201,
      await context.importService.import(input, {
        scope: businessScope(input),
      }),
    );
    return true;
  }
  if (route === "/exports" && ["POST", "GET"].includes(method)) {
    const input =
      method === "POST"
        ? await body()
        : {
            format: params.format || "json",
            filters: readFilters(),
            ...readScope(),
          };
    const selected = businessScope(input, { read: true }),
      result = await context.exportService.export({
        ...input,
        scope: selected.allTargets ? undefined : selected,
        filters: { ...input.filters, ...selected },
      });
    res.writeHead(200, {
      "Content-Type": result.contentType,
      "Content-Disposition": 'attachment; filename="' + result.filename + '"',
      "Cache-Control": "no-store",
    });
    res.end(result.body);
    return true;
  }
  if (route === "/legacy-records" && method === "GET") {
    const items = await context.assignmentService.list();
    send(200, { items, total: items.length });
    return true;
  }
  if (route === "/legacy-records/assignment-preview" && method === "POST") {
    send(200, await context.assignmentService.preview(await body()));
    return true;
  }
  if (route === "/legacy-records/assign" && method === "POST") {
    send(200, await context.assignmentService.move(await body()));
    return true;
  }
  if (
    (match = route.match(/^\/legacy-records\/([^/]+)$/)) &&
    method === "GET"
  ) {
    send(
      200,
      await context.assignmentService.get(decodeURIComponent(match[1])),
    );
    return true;
  }
  return false;
}
