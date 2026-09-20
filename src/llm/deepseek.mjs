// DeepSeek 客户端：JSON 模式、重试、并发限制、用量统计
import { pool, sleep } from '../util/text.mjs';

export class DeepSeekError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.body = body;
  }
}

export class DeepSeek {
  constructor(cfg) {
    this.apiKey = cfg.deepseek.apiKey;
    this.baseUrl = (cfg.deepseek.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
    this.model = cfg.deepseek.model || 'deepseek-chat';
    this.concurrency = Math.max(1, Number(cfg.deepseek.concurrency) || 4);
    this.timeoutMs = Number(cfg.deepseek.timeoutMs) || 120000;
    this.usage = { calls: 0, promptTokens: 0, completionTokens: 0, failures: 0 };
    this._noJsonMode = false;
  }

  get available() {
    return Boolean(this.apiKey);
  }

  assertAvailable() {
    if (!this.available) {
      throw new DeepSeekError(
        '未配置 DeepSeek API Key。请在 config.json 的 deepseek.apiKey 填入密钥，或设置环境变量 DEEPSEEK_API_KEY。',
      );
    }
  }

  async _request(messages, { temperature = 0.2, maxTokens = 4000, json = false, retries = 3 } = {}) {
    this.assertAvailable();
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const body = {
        model: this.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      };
      if (json && !this._noJsonMode) body.response_format = { type: 'json_object' };

      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          // 某些模型不支持 response_format：降级重试一次
          if (json && !this._noJsonMode && res.status === 400 && /response_format|json_object/i.test(text)) {
            this._noJsonMode = true;
            attempt--;
            continue;
          }
          // 限流 / 服务端错误 → 退避重试
          if (res.status === 429 || res.status >= 500) {
            lastErr = new DeepSeekError(`DeepSeek 返回 ${res.status}`, { status: res.status, body: text.slice(0, 500) });
            await sleep(Math.min(20000, 1200 * 2 ** attempt) + Math.random() * 500);
            continue;
          }
          throw new DeepSeekError(`DeepSeek 返回 ${res.status}: ${text.slice(0, 300)}`, { status: res.status, body: text.slice(0, 800) });
        }

        const data = await res.json();
        this.usage.calls++;
        if (data.usage) {
          this.usage.promptTokens += data.usage.prompt_tokens || 0;
          this.usage.completionTokens += data.usage.completion_tokens || 0;
        }
        const content = data.choices?.[0]?.message?.content ?? '';
        const finish = data.choices?.[0]?.finish_reason;
        if (!content) {
          lastErr = new DeepSeekError(`DeepSeek 返回空内容 (finish_reason=${finish})`);
          await sleep(800 * (attempt + 1));
          continue;
        }
        return { content, finish, raw: data };
      } catch (e) {
        if (e instanceof DeepSeekError && e.status && e.status !== 429 && e.status < 500) throw e;
        lastErr = e;
        if (attempt < retries) {
          await sleep(Math.min(20000, 1000 * 2 ** attempt) + Math.random() * 400);
          continue;
        }
      }
    }
    this.usage.failures++;
    throw lastErr || new DeepSeekError('DeepSeek 调用失败（已重试）');
  }

  /** 纯文本补全 */
  async chat(system, user, opts = {}) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });
    const { content } = await this._request(messages, opts);
    return content;
  }

  /** JSON 补全：自动从 ```json 围栏或多余文本中提取对象/数组 */
  async chatJson(system, user, opts = {}) {
    const content = await this.chat(system, user, { ...opts, json: true });
    return parseJsonLoose(content);
  }

  /** 批量并发执行（受限并发） */
  async mapPool(items, worker) {
    return pool(items, this.concurrency, worker);
  }
}

/** 宽松 JSON 解析：容忍围栏、前后缀说明文字、尾随逗号 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return text;
  let s = text.trim();
  if (!s) throw new Error('LLM 返回为空，无法解析 JSON');

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
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    try {
      return JSON.parse(repaired);
    } catch {
      return undefined;
    }
  };

  let v = attempt(s);
  if (v !== undefined) return v;

  // 截取首个 { ... } 或 [ ... ]
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = s.indexOf(open);
    const end = s.lastIndexOf(close);
    if (start !== -1 && end > start) {
      v = attempt(s.slice(start, end + 1));
      if (v !== undefined) return v;
    }
  }
  throw new Error(`无法解析 LLM 返回的 JSON：${s.slice(0, 300)}`);
}
