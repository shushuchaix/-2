import { pool } from "../util/text.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { createModelBudget } from "./budget.mjs";
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
    } = {},
  ) {
    const c = cfg.deepseek || {};
    this.apiKey = c.apiKey;
    this.baseUrl = (c.baseUrl || "https://api.deepseek.com").replace(/\/$/, "");
    this.model = c.model || "deepseek-chat";
    this.concurrency = Math.max(1, Number(c.concurrency) || 4);
    this.timeoutMs = Number(c.timeoutMs) || 120000;
    this.signal = signal;
    this.budget = budget;
    this.transport = transport;
    this.retryDelayMs = retryDelayMs;
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
    } = {},
  ) {
    this.assertAvailable();
    const combined = [this.signal, signal].filter(Boolean);
    const caller = combined.length ? AbortSignal.any(combined) : undefined;
    let lastError;
    const limit = Math.max(0, Math.min(3, Number(retries) || 0));
    for (let attempt = 0; attempt <= limit; attempt++) {
      caller?.throwIfAborted();
      this.budget.claimRequest();
      const body = {
        model: this.model,
        messages,
        temperature,
        max_tokens: Math.max(
          1,
          Math.min(
            Number(maxTokens) || 4000,
            this.budget.snapshot().maxOutputTokens,
          ),
        ),
        stream: false,
      };
      if (json && !this._noJsonMode)
        body.response_format = { type: "json_object" };
      let retry = false;
      try {
        const requestSignal = AbortSignal.any([
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
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          if (
            json &&
            !this._noJsonMode &&
            response.status === 400 &&
            /response_format|json_object/i.test(text)
          ) {
            this._noJsonMode = true;
            attempt--;
            continue;
          }
          const error = new DeepSeekError("模型 HTTP " + response.status, {
            status: response.status,
          });
          if (response.status !== 429 && response.status < 500) throw error;
          lastError = error;
          retry = true;
        } else {
          const data = await response.json();
          this.usage.calls++;
          this.usage.promptTokens += data.usage?.prompt_tokens || 0;
          this.usage.completionTokens += data.usage?.completion_tokens || 0;
          const content = data.choices?.[0]?.message?.content;
          if (content)
            return {
              content,
              finish: data.choices[0].finish_reason,
              raw: data,
            };
          lastError = new DeepSeekError("模型返回空内容");
          retry = true;
        }
      } catch (error) {
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
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: user });
    return (await this._request(messages, opts)).content;
  }
  async chatJson(system, user, opts = {}) {
    const content = await this.chat(system, user, { ...opts, json: true });
    try {
      return parseJsonLoose(content);
    } catch {
      if (opts.repair === false) throw new DeepSeekError("模型 JSON 格式无效");
      const repaired = await this.chat(
        "将输入转换为有效JSON，不添加或改写事实；只输出JSON。",
        String(content).slice(0, 30000),
        { ...opts, json: true, retries: 0 },
      );
      try {
        return parseJsonLoose(repaired);
      } catch {
        throw new DeepSeekError("模型 JSON 格式修复失败");
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
