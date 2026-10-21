import { pool } from "../util/text.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { createModelBudget, isOfficialDeepSeekFlash } from "./budget.mjs";
import { randomUUID } from "node:crypto";
import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";
function annotate(error, phase, requestId) {
  try {
    if (error && typeof error === "object") {
      error.phase ||= phase;
      error.requestId ||= requestId;
    }
  } catch {
    /* Diagnostic fields must not replace the original error. */
  }
}
const chatMessages = (system, user) => [
  ...(system ? [{ role: "system", content: system }] : []),
  { role: "user", content: user },
];
export class DeepSeekError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "DeepSeekError";
    this.status = status;
    this.body = body;
  }
}
export class DeepSeek {
  constructor(
    cfg,
    {
      signal,
      budget = createModelBudget(),
      transport = globalThis.fetch,
      retryDelayMs,
      diagnostics,
      diagnosticContext = {},
    } = {},
  ) {
    const c = cfg.deepseek || {};
    this.apiKey = c.apiKey;
    this.baseUrl = (c.baseUrl || "https://api.deepseek.com").replace(/\/$/, "");
    this.model = c.model || "deepseek-flash";
    this.concurrency = Math.max(1, Number(c.concurrency) || 4);
    this.timeoutMs = Number(c.timeoutMs) || 120000;
    this.signal = signal;
    this.budget = budget;
    this.budget.assertModel?.({ baseUrl: this.baseUrl, model: this.model });
    this.transport = transport;
    this.retryDelayMs = retryDelayMs;
    this.diagnostics = diagnostics;
    this.diagnosticContext = diagnosticContext;
    this.usage = {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      failures: 0,
    };
    this._noJsonMode = false;
  }
  get available() {
    return Boolean(this.apiKey);
  }
  assertAvailable() {
    if (!this.available) throw new DeepSeekError("未配置模型 API Key。");
  }
  async _request(
    messages,
    {
      temperature = 0.2,
      maxTokens = 4000,
      json = false,
      retries = 3,
      signal,
      diagnosticContext = {},
    } = {},
  ) {
    this.assertAvailable();
    const combined = [this.signal, signal].filter(Boolean);
    const caller = combined.length ? AbortSignal.any(combined) : undefined;
    const trace = { ...this.diagnosticContext, ...diagnosticContext };
    let lastError;
    let physicalAttempt = 0;
    const limit = Math.max(0, Math.min(3, Number(retries) || 0));
    for (let attempt = 0; attempt <= limit; attempt++) {
      caller?.throwIfAborted();
      const requestId = "q-" + randomUUID(),
        started = Date.now();
      const requestedOutput = Number(maxTokens),
        body = {
          model: this.model,
          messages,
          temperature,
          max_tokens: Math.max(
            1,
            Math.min(
              Math.floor(
                Number.isFinite(requestedOutput) ? requestedOutput : 4000,
              ),
              this.budget.snapshot().maxOutputTokens,
            ),
          ),
          stream: false,
        };
      if (isOfficialDeepSeekFlash({ baseUrl: this.baseUrl, model: this.model }))
        body.thinking = { type: "disabled" };
      if (json && !this._noJsonMode)
        body.response_format = { type: "json_object" };
      physicalAttempt++;
      let claim;
      try {
        claim = await this.budget.claimRequest({
          baseUrl: this.baseUrl,
          model: this.model,
          maxOutputTokens: body.max_tokens,
        });
      } catch (error) {
        annotate(error, "budget", requestId);
        await recordDiagnostic(
          this.diagnostics,
          {
            operation: "model.request",
            ...trace,
            requestId,
            endpointKind: "model",
            method: "POST",
            phase: "budget",
            outcome: "failed",
            attempt: physicalAttempt,
            durationMs: Date.now() - started,
            usage: { model: this.budget.snapshot() },
          },
          error,
        );
        throw error;
      }
      let retry = false;
      let phase = "transport",
        outcome = "failed",
        httpStatus,
        requestSignal,
        attemptError,
        responseUsage;
      try {
        requestSignal = AbortSignal.any([
          ...(caller ? [caller] : []),
          AbortSignal.timeout(this.timeoutMs),
        ]);
        const response = await this.transport(
          this.baseUrl + "/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + this.apiKey,
            },
            body: JSON.stringify(body),
            signal: requestSignal,
          },
        );
        phase = "response";
        httpStatus = response.status;
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          if (
            json &&
            !this._noJsonMode &&
            response.status === 400 &&
            /response_format|json_object/i.test(text)
          ) {
            this._noJsonMode = true;
            outcome = "partial";
            await recordDiagnostic(this.diagnostics, {
              operation: "model.fallback",
              ...trace,
              requestId,
              endpointKind: "model",
              phase: "response",
              outcome: "partial",
              code: "json_mode_unsupported",
              httpStatus: 400,
              attempt: physicalAttempt,
            });
            attempt--;
            continue;
          }
          const error = new DeepSeekError("模型 HTTP " + response.status, {
            status: response.status,
          });
          error.code = "model_http_failed";
          error.phase = phase;
          error.requestId = requestId;
          attemptError = error;
          if (response.status !== 429 && response.status < 500) throw error;
          lastError = error;
          retry = true;
        } else {
          phase = "parse";
          const data = await response.json();
          responseUsage = data.usage;
          this.usage.calls++;
          for (const [key, tokenKey] of [
            ["promptTokens", "prompt_tokens"],
            ["completionTokens", "completion_tokens"],
          ])
            if (
              Number.isSafeInteger(responseUsage?.[tokenKey]) &&
              responseUsage[tokenKey] >= 0 &&
              Number.isSafeInteger(this.usage[key] + responseUsage[tokenKey])
            )
              this.usage[key] += responseUsage[tokenKey];
          const content = data.choices?.[0]?.message?.content;
          if (content) {
            outcome = "success";
            return {
              content,
              finish: data.choices[0].finish_reason,
              raw: data,
              requestId,
            };
          }
          lastError = Object.assign(new DeepSeekError("模型返回空内容"), {
            code: "model_empty_response",
            phase: "response",
            requestId,
          });
          attemptError = lastError;
          retry = true;
        }
      } catch (error) {
        attemptError = error;
        annotate(error, phase, requestId);
        if (caller?.aborted) outcome = "cancelled";
        else if (
          error.name === "TimeoutError" ||
          requestSignal?.reason?.name === "TimeoutError"
        )
          outcome = "timeout";
        if (
          caller?.aborted ||
          error.name === "AbortError" ||
          error.code === "model_budget_exhausted"
        )
          throw error;
        if (
          error instanceof DeepSeekError &&
          error.status &&
          error.status !== 429 &&
          error.status < 500
        )
          throw error;
        lastError = error;
        retry = true;
      } finally {
        await this.budget.settleRequest?.(claim, responseUsage);
        const code =
          outcome === "cancelled"
            ? "request_cancelled"
            : outcome === "timeout"
              ? "request_timeout"
              : undefined;
        const safeError = code
          ? Object.assign(Error(code), {
              name: outcome === "cancelled" ? "AbortError" : "TimeoutError",
              code,
              phase,
              requestId,
            })
          : attemptError;
        await recordDiagnostic(
          this.diagnostics,
          {
            operation: "model.request",
            ...trace,
            requestId,
            endpointKind: "model",
            method: "POST",
            phase,
            outcome:
              retry && attempt < limit && outcome === "failed"
                ? "retrying"
                : outcome,
            ...(code
              ? {
                  code,
                  abortedBy: outcome === "cancelled" ? "caller" : "timeout",
                }
              : {}),
            attempt: physicalAttempt,
            retryCount: attempt,
            httpStatus,
            timeoutMs: this.timeoutMs,
            durationMs: Math.max(0, Date.now() - started),
            usage: { model: { ...this.budget.snapshot(), ...this.usage } },
          },
          safeError,
        );
      }
      if (retry && attempt < limit)
        await delay(
          this.retryDelayMs ?? Math.min(20000, 1000 * 2 ** attempt),
          undefined,
          { signal: caller },
        );
    }
    this.usage.failures++;
    throw lastError || new DeepSeekError("模型调用失败");
  }
  async chat(system, user, opts = {}) {
    return (await this._request(chatMessages(system, user), opts)).content;
  }
  async chatJson(system, user, opts = {}) {
    const reportResponse = (metadata) => {
      try {
        Promise.resolve(opts.onResponse?.(metadata)).catch(() => {});
      } catch {
        /* Response observers cannot replace a successfully parsed answer. */
      }
    };
    const { content, requestId } = await this._request(
      chatMessages(system, user),
      { ...opts, json: true },
    );
    try {
      const result = parseJsonLoose(content);
      reportResponse({ requestId });
      return result;
    } catch {
      await recordDiagnostic(this.diagnostics, {
        operation: "model.validation",
        ...this.diagnosticContext,
        ...opts.diagnosticContext,
        requestId,
        phase: "parse",
        outcome: opts.repair === false ? "failed" : "retrying",
        code: opts.repair === false ? "model_json_invalid" : "json_repair",
        parser: {
          format: "json",
          resultType: "unknown",
          documentLength: content.length,
        },
      });
      if (opts.repair === false) throw new DeepSeekError("模型 JSON 格式无效");
      const { content: repaired, requestId: repairRequestId } =
        await this._request(
          chatMessages(
            "将输入转换为有效JSON，不添加或改写事实；只输出JSON。",
            String(content).slice(0, 30000),
          ),
          { ...opts, json: true, retries: 0 },
        );
      try {
        const result = parseJsonLoose(repaired);
        await recordDiagnostic(this.diagnostics, {
          operation: "model.validation",
          ...this.diagnosticContext,
          ...opts.diagnosticContext,
          requestId: repairRequestId,
          parentRequestId: requestId,
          phase: "parse",
          outcome: "success",
          code: "json_repaired",
          parser: {
            format: "json",
            resultType:
              result === null
                ? "null"
                : Array.isArray(result)
                  ? "array"
                  : typeof result,
            documentLength: repaired.length,
          },
        });
        reportResponse({
          requestId: repairRequestId,
          parentRequestId: requestId,
        });
        return result;
      } catch {
        const error = Object.assign(
          new DeepSeekError("模型 JSON 格式修复失败"),
          { code: "model_json_repair_failed", phase: "parse" },
        );
        await recordDiagnostic(
          this.diagnostics,
          {
            operation: "model.validation",
            ...this.diagnosticContext,
            ...opts.diagnosticContext,
            requestId: repairRequestId,
            parentRequestId: requestId,
            phase: "parse",
            outcome: "failed",
            code: error.code,
            parser: { format: "json", documentLength: repaired.length },
          },
          error,
        );
        throw error;
      }
    }
  }
  async mapPool(items, worker) {
    return pool(items, this.concurrency, worker);
  }
}

/** 宽松 JSON 解析：容忍围栏、前后缀说明文字、尾随逗号 */
export function parseJsonLoose(text) {
  if (typeof text !== "string") return text;
  let s = text.trim();
  if (!s) throw new Error("LLM 返回为空，无法解析 JSON");

  // 去掉 markdown 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const attempt = (str) => {
    try {
      return JSON.parse(str);
    } catch {
      /* 继续尝试修复 */
    }
    const repaired = str
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
    try {
      return JSON.parse(repaired);
    } catch {
      return undefined;
    }
  };

  let v = attempt(s);
  if (v !== undefined) return v;

  // 截取首个 { ... } 或 [ ... ]
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ]) {
    const start = s.indexOf(open);
    const end = s.lastIndexOf(close);
    if (start !== -1 && end > start) {
      v = attempt(s.slice(start, end + 1));
      if (v !== undefined) return v;
    }
  }
  throw new Error(`无法解析 LLM 返回的 JSON：${s.slice(0, 300)}`);
}
