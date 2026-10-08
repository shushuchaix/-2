import path from "node:path";
import { projectJobApplication } from "../domain/job-resolution.mjs";
import {
  runPipeline,
  saveRun,
  listRuns,
  loadRun,
  createLegacyRunInput,
} from "../pipeline.mjs";
import { exportResult } from "../export.mjs";
import { extractResumeText, looksLikeResume } from "../resume/extract-text.mjs";
import {
  resumeText,
  identifier,
  jobIdentifier,
  userCredentials,
  invalid,
} from "./validation.mjs";
import { STATUSES, STATUS_LABELS } from "../store.mjs";
export async function handleV1Request(req, res, context) {
  const url = new URL(req.url, "http://localhost"),
    route = url.pathname,
    method = req.method,
    { http } = context;
  const send = (status, data) => http.json(req, res, status, data);
  let match;
  if (route === "/api/upload" && method === "POST") {
    const input = await http.readJson(req);
    if (!input.base64) invalid("缺少文件内容");
    try {
      const buffer = Buffer.from(
        String(input.base64).replace(/^data:[^;]+;base64,/, ""),
        "base64",
      );
      if (!buffer.length) invalid("文件内容为空");
      const { text, format } = await extractResumeText(
        buffer,
        input.filename || "resume.txt",
      );
      if (text.length < 30)
        invalid("未能从文件中提取有效文字，请粘贴简历正文", 422);
      send(200, {
        text,
        format,
        length: text.length,
        looksLikeResume: looksLikeResume(text),
        filename: input.filename || "resume.txt",
      });
    } catch (error) {
      send(error.status || 422, { error: error.message });
    }
    return true;
  }
  if (route === "/api/analyze" && method === "POST") {
    const input = await http.readJson(req),
      text = resumeText(input.resumeText),
      credentials = {
        ...userCredentials(input, context.cfg),
        ip: http.ip(req),
      },
      permit = context.gate.acquire(credentials.ip);
    if (!permit.ok) {
      send(permit.status, {
        error: permit.reason,
        retryAfterMs: permit.retryAfterMs,
      });
      return true;
    }
    const buffered = [];
    let legacyInput, startedRun;
    try {
      legacyInput = await createLegacyRunInput({
        resumeText: text,
        cfg: context.cfg,
        options: input.options || {},
        context,
        credentials: { ...credentials, permit },
        onEvent: (event) => buffered.push(event),
      });
      startedRun = await context.runService.startRun(legacyInput);
    } catch (error) {
      permit.release();
      await legacyInput?.operationLease?.release();
      throw error;
    }
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    let disconnected = false;
    const close = () => (disconnected = true);
    res.once("close", close);
    const emit = (event) => {
      if (!disconnected && !res.writableEnded)
        res.write(JSON.stringify(event) + "\n");
    };
    const heartbeat = setInterval(
      () => emit({ type: "ping", t: Date.now() }),
      15000,
    );
    heartbeat.unref?.();
    try {
      for (const event of buffered) emit(event);
      const result = await runPipeline({
        resumeText: text,
        cfg: context.cfg,
        options: input.options || {},
        context,
        credentials: { ...credentials, permit },
        legacyInput,
        startedRun,
        onEvent: emit,
      });
      const file = await saveRun(result, { context });
      emit({
        type: "saved",
        file: path
          .relative(context.repository.dataDir, file)
          .split(path.sep)
          .join("/"),
        runId: result.runId,
      });
      emit({ type: "quota", quota: context.gate.peek(credentials.ip) });
      emit({ type: "done" });
    } catch (error) {
      emit({
        type: "error",
        message: error.code === "ENOSPC" ? "结果未能写入存储" : error.message,
      });
      emit({ type: "done" });
    } finally {
      clearInterval(heartbeat);
      permit.release();
      res.removeListener("close", close);
      res.end();
    }
    return true;
  }
  if (route === "/api/runs" && method === "GET") {
    send(200, { runs: await listRuns(100, { context }) });
    return true;
  }
  if ((match = route.match(/^\/api\/runs\/([^/]+)(?:\/(export))?$/))) {
    const id = identifier(decodeURIComponent(match[1]));
    if (!match[2] && method === "DELETE") {
      await context.repository.mutateWorkspace((w) => {
        if (w.runs[id]) w.runs[id].deletedAt = new Date().toISOString();
      });
      send(200, { ok: true });
      return true;
    }
    if (method === "GET") {
      const run = await loadRun(id, { context });
      if (!run) invalid("未找到该运行记录", 404);
      if (match[2]) {
        const result = exportResult(
          run,
          url.searchParams.get("format") || "json",
        );
        res.writeHead(200, {
          "Content-Type": result.mime,
          "Content-Disposition":
            'attachment; filename="jobs-' + id + "." + result.ext + '"',
          "Cache-Control": "no-store",
        });
        res.end(result.body);
      } else send(200, run);
      return true;
    }
  }
  if (route === "/api/tracking/summary" && method === "GET") {
    const w = await context.repository.read(),
      byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const job of Object.values(w.jobs))
      byStatus[projectJobApplication(w, job.jobId).status]++;
    send(200, {
      total: Object.keys(w.jobs).length,
      byStatus,
      statusLabels: STATUS_LABELS,
      staleCount: Object.values(w.jobs).filter(
        (j) => j.lifecycle === "notRecentlySeen",
      ).length,
      runs: Object.keys(w.runs).length,
      updatedAt:
        Object.values(w.jobs)
          .map((j) => j.lastSeen)
          .sort()
          .at(-1) || "",
    });
    return true;
  }
  if (route === "/api/tracking/jobs" && method === "GET") {
    const status = url.searchParams.get("status") || undefined;
    if (status && !STATUSES.includes(status)) invalid("Invalid status");
    const raw = url.searchParams.get("limit") || "200";
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1000)
      invalid("Invalid limit");
    const result = await context.jobService.queryJobs({
      status,
      pageSize: 200,
    });
    const rows = [...result.items];
    for (
      let page = 2;
      rows.length < Math.min(result.total, Number(raw));
      page++
    )
      rows.push(
        ...(await context.jobService.queryJobs({ status, pageSize: 200, page }))
          .items,
      );
    send(200, {
      jobs: rows.slice(0, Number(raw)).map((i) => ({
        ...i,
        id: i.jobId,
        status: i.application.status,
        note: i.application.note,
        city: i.cities.join(" / "),
        firstSeen: i.job.firstSeen,
        lastSeen: i.job.lastSeen,
      })),
    });
    return true;
  }
  if (
    (match = route.match(/^\/api\/tracking\/jobs\/([^/]+)$/)) &&
    method === "POST"
  ) {
    const input = await http.readJson(req);
    if (!input.status) invalid("缺少status字段");
    try {
      send(200, {
        ok: true,
        job: await context.jobService.updateApplication(
          jobIdentifier(decodeURIComponent(match[1])),
          {
            status: input.status,
            ...(Object.hasOwn(input, "note")
              ? { note: String(input.note) }
              : {}),
          },
        ),
      });
    } catch (error) {
      if (error.status === 409) throw error;
      send(error.status || 400, {
        error: error.message,
        allowed: STATUSES,
        fieldErrors: error.fieldErrors,
        code: error.code,
      });
    }
    return true;
  }
  return false;
}
