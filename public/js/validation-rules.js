// Shared by browser forms and application services. Messages never include input values.
const own = (v, k) => Object.hasOwn(v, k);
const blank = (v) => v == null || v === "";
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v) =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-]{1,160}$/.test(v) &&
  !["__proto__", "constructor", "prototype"].includes(v);
const revision = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,160}@[1-9][0-9]*$/.test(v);
export function isVerifiedCostModel(model) {
  if (model?.model !== "deepseek-flash") return false;
  try {
    const url = new URL(model.baseUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.deepseek.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      ["/", "/v1", "/v1/"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}
export function isCalendarDate(v) {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$)/.test(
      v,
    ) ||
    !Number.isFinite(Date.parse(v))
  )
    return false;
  return (
    new Date(v.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) ===
    v.slice(0, 10)
  );
}
export function inputError(
  fieldErrors,
  message = "填写检查未通过，请修改标出的项目。",
  status = 400,
) {
  return Object.assign(Error(message), {
    status,
    code: "invalid_input",
    fieldErrors,
  });
}
export function validateInput(kind, input, options = {}) {
  const errors = {};
  if (!plain(input)) return { _form: "请提交有效的填写内容。" };
  const fail = (k, m) => {
    errors[k] ||= m;
  };
  const text = (k, v, max, required = false) => {
    if (blank(v) && !required) return;
    if (typeof v !== "string" || (required && !v.trim()))
      fail(k, "请填写此项。");
    else if (v.length > max) fail(k, `内容不能超过 ${max} 个字符。`);
    else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))
      fail(k, "请删除不可见的控制字符。");
  };
  const choice = (k, v, choices, required = false) => {
    if ((required || !blank(v)) && !choices.includes(v))
      fail(k, "请选择有效选项。");
  };
  const ident = (k, v, required = false, isRevision = false, refs) => {
    if (blank(v) && !required) return;
    if (!(isRevision ? revision(v) : id(v)))
      fail(
        k,
        "请选择有效项目；手填编号仅可使用英文字母、数字、下划线和短横线。",
      );
    else if (refs && !refs.includes(v)) fail(k, "该项目已不存在，请重新选择。");
  };
  const year = (k, v) => {
    if (
      !blank(v) &&
      (!/^\d{4}$/.test(String(v)) || Number(v) < 1900 || Number(v) > 2100)
    )
      fail(k, "请填写 1900–2100 之间的四位年份，未知可留空。");
  };
  const strings = (
    k,
    v,
    required = false,
    structured = false,
    maxLength = 200,
  ) => {
    if (v == null && !required) return;
    if (!Array.isArray(v) || (required && !v.length)) {
      fail(k, required ? "请至少填写或选择一项。" : "请填写有效列表。");
      return;
    }
    if (v.length > 100) fail(k, "最多填写 100 项。");
    for (const x of v) {
      if (structured && plain(x)) {
        text(k, x.name || x.description, maxLength, true);
        if (own(x, "name")) text(k, x.name, 200);
        if (own(x, "description")) text(k, x.description, maxLength);
        if (own(x, "proficiency")) text(k, x.proficiency, 200);
      } else text(k, x, maxLength, true);
    }
  };
  const number = (k, v, max, min = 0) => {
    if (
      blank(v) ||
      (options.nativeTypes && typeof v !== "number") ||
      (typeof v !== "number" && typeof v !== "string") ||
      !/^\d+$/.test(String(v)) ||
      !Number.isSafeInteger(Number(v)) ||
      Number(v) < min ||
      Number(v) > max
    )
      fail(k, `请填写 ${min}–${max} 之间的整数。`);
  };
  const url = (k, v, required = false, isPublic = false) => {
    if (blank(v) && !required) return;
    text(k, v, 2048, required);
    try {
      if (typeof v !== "string" || /\s/.test(v)) throw Error();
      const u = new URL(v);
      if (!["http:", "https:"].includes(u.protocol)) throw Error();
      if (u.username || u.password) {
        fail(k, "网址不能包含用户名或密码，请删除网址中的凭据。");
        return;
      }
      const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (
        isPublic &&
        (host === "localhost" ||
          host.endsWith(".localhost") ||
          host.endsWith(".local") ||
          /^(0|10|127|169\.254|192\.168)\./.test(host) ||
          /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
          (host.includes(":") && /^(::|fc|fd|fe[89ab])/.test(host)))
      )
        fail(k, "招聘来源需使用可公开访问的网址，不能使用本机或内网地址。");
    } catch {
      fail(k, "请填写完整的 http:// 或 https:// 网址。");
    }
  };
  const key = (k, v, required = false) => {
    if (blank(v) && !required) return;
    if (
      typeof v !== "string" ||
      !v ||
      v.length > 512 ||
      /[\s\u0000-\u001f\u007f]/.test(v)
    )
      fail(k, "请填写不含空白字符、长度不超过 512 的 API Key。");
  };
  const budgets = (v) => {
    if (!plain(v)) {
      fail("budgets", "预算需为有效配置。");
      return;
    }
    const clearingCost =
      own(v, "maxCostCny") && v.maxCostCny === null && kind === "settings";
    const moneyMode =
      !clearingCost &&
      ((own(v, "maxCostCny") && v.maxCostCny != null) ||
        Number.isFinite(options.maxCostCny));
    const caps = {
      maxModelRequests: moneyMode ? 1000 : 20,
      maxRequests: 240,
      maxDetails: 20,
      maxSites: 24,
    };
    for (const [k, val] of Object.entries(v)) {
      if (k === "maxCostCny") {
        if (clearingCost) continue;
        if (
          blank(val) ||
          (options.nativeTypes && typeof val !== "number") ||
          (typeof val !== "number" && typeof val !== "string") ||
          !/^\d+(?:\.\d{1,2})?$/.test(String(val)) ||
          !Number.isFinite(Number(val)) ||
          Number(val) < 0 ||
          Number(val) > 10
        )
          fail(
            "budgets.maxCostCny",
            "请填写 0–10 元之间的金额，最多两位小数；0 表示不发起模型调用。",
          );
        else if (!isVerifiedCostModel({ ...options.model, ...input.model }))
          fail(
            "budgets.maxCostCny",
            "费用预算仅支持已核实价格的官方 https://api.deepseek.com（可加 /v1）和 deepseek-flash 模型。兼容服务商请将费用留空，使用请求次数预算。",
          );
      } else if (!own(caps, k)) fail("budgets." + k, "不支持此预算项目。");
      else number("budgets." + k, val, caps[k]);
    }
  };
  switch (kind) {
    case "profile": {
      if (!options.partial || own(input, "text")) {
        text("text", input.text, 60000, !options.partial);
        if (
          (!options.partial || own(input, "text")) &&
          typeof input.text === "string" &&
          input.text.trim().length < 30
        )
          fail("text", "简历正文至少需要 30 个字符。");
      }
      const p = input.profile || input;
      if (!plain(p) || (input.overrides != null && !plain(input.overrides))) {
        fail("profile", "画像需为有效填写内容。");
        break;
      }
      const facts = { ...p, ...(input.overrides || {}) };
      text("profile.name", facts.name, 200);
      text("profile.major", facts.major, 200);
      choice("profile.education", facts.education || facts.degree, [
        "未知",
        "大专",
        "本科",
        "硕士",
        "博士",
        "高中",
        "中专",
        "不限",
      ]);
      year("profile.graduationYear", facts.graduationYear);
      for (const k of ["cities", "certificates", "skills", "projects"])
        strings(
          "profile." + k,
          facts[k],
          false,
          ["certificates", "skills", "projects"].includes(k),
          k === "projects" ? 20000 : 200,
        );
      if (own(input, "profileId")) ident("profileId", input.profileId);
      break;
    }
    case "target": {
      ident(
        "profileRevisionId",
        input.profileRevisionId,
        true,
        true,
        options.profileRevisionIds,
      );
      if (own(input, "targetId")) ident("targetId", input.targetId);
      strings("roles", input.roles || input.targetRoles, true);
      const cityMode =
        input.cityMode ||
        (input.cities == null
          ? "from_profile"
          : input.cities.length
            ? "selected"
            : "any");
      choice("cityMode", cityMode, ["any", "from_profile", "selected"], true);
      strings("cities", input.cities || [], cityMode === "selected");
      const policy =
        input.degreePolicy ||
        (input.minDegree ? "minimum_requirement" : "eligibility");
      choice(
        "degreePolicy",
        policy,
        ["eligibility", "minimum_requirement"],
        true,
      );
      if (policy === "minimum_requirement")
        choice(
          "minDegree",
          input.minDegree,
          ["大专", "本科", "硕士", "博士"],
          true,
        );
      year("graduationYear", input.graduationYear);
      strings("jobTypes", input.jobTypes || ["campus", "internship"], true);
      if (
        Array.isArray(input.jobTypes) &&
        input.jobTypes.some(
          (x) => !["campus", "internship", "social", "unknown"].includes(x),
        )
      )
        fail("jobTypes", "请选择有效的招聘类型。");
      strings("sourceIds", input.sourceIds);
      strings("siteIds", input.siteIds);
      for (const k of ["sourceIds", "siteIds"])
        if (Array.isArray(input[k]))
          for (const v of input[k])
            ident(
              k,
              v,
              false,
              false,
              k === "sourceIds" ? options.sourceIds : options.siteIds,
            );
      choice(
        "coverageMode",
        input.coverageMode || "standard",
        ["standard", "broad"],
        true,
      );
      if (input.budgets != null) budgets(input.budgets);
      if (own(input, "enabled") && typeof input.enabled !== "boolean")
        fail("enabled", "启用状态必须为是或否。");
      break;
    }
    case "settings": {
      if (input.model != null && !plain(input.model))
        fail("model", "模型设置需为有效配置。");
      const m = input.model || {};
      if (own(m, "baseUrl") || options.requireModel)
        url("model.baseUrl", m.baseUrl, true);
      if (own(m, "model") || options.requireModel)
        text("model.model", m.model, 200, true);
      if (own(m, "apiKey")) key("model.apiKey", m.apiKey);
      if (own(input, "userApiKey")) key("userApiKey", input.userApiKey);
      if (input.budgets != null) budgets(input.budgets);
      break;
    }
    case "key":
      key("userApiKey", input.userApiKey, options.required);
      break;
    case "application":
      if (own(input, "status"))
        choice(
          "status",
          input.status,
          [
            "new",
            "seen",
            "interested",
            "applied",
            "interviewing",
            "offer",
            "rejected",
            "ignored",
          ],
          true,
        );
      if (own(input, "note")) {
        if (typeof input.note !== "string")
          fail("note", "备注需为文字；可清空为留空字符串。");
        else text("note", input.note, 20000);
      }
      for (const k of ["appliedAt", "followUpAt"])
        if (!blank(input[k]) && !isCalendarDate(input[k]))
          fail(k, "请填写真实日期（年-月-日），例如 2026-10-06。");
      ident(
        "resumeRevisionId",
        input.resumeRevisionId,
        false,
        true,
        options.profileRevisionIds,
      );
      break;
    case "filters":
      choice("status", input.status, [
        "new",
        "seen",
        "interested",
        "applied",
        "interviewing",
        "offer",
        "rejected",
        "ignored",
      ]);
      choice("kind", input.kind, [
        "job",
        "recruitment_notice",
        "company_campaign",
      ]);
      choice("qualification", input.qualification, ["pass", "fail", "unknown"]);
      choice("recommendation", input.recommendation, [
        "high",
        "consider",
        "low",
        "insufficient",
        "not_recommended",
      ]);
      text("search", input.search, 2000);
      text("city", input.city, 200);
      strings("cities", input.cities);
      ident("sourceId", input.sourceId);
      ident("targetId", input.targetId);
      ident(
        "targetRevisionId",
        input.targetRevisionId,
        false,
        true,
        options.targetRevisionIds,
      );
      if (!blank(input.since) && !isCalendarDate(input.since))
        fail("since", "请填写真实日期（年-月-日）。");
      if (own(input, "page"))
        number("page", input.page, Number.MAX_SAFE_INTEGER, 1);
      if (own(input, "pageSize")) number("pageSize", input.pageSize, 200, 1);
      break;
    case "link":
      text("jobId", input.jobId, 1000, true);
      if (
        typeof input.jobId === "string" &&
        (/[\u0000-\u001f\u007f]/.test(input.jobId) ||
          ["__proto__", "constructor", "prototype"].includes(input.jobId))
      )
        fail("jobId", "岗位编号无效。");
      if (input.jobId && input.jobId === options.selfId)
        fail("jobId", "不能将岗位关联到自身。");
      break;
    case "import": {
      url("url", input.url, false, true);
      text("title", input.title, 200);
      text("account", input.account, 200);
      text("text", input.text, 60000);
      text("note", input.note, 20000);
      if (!input.url && !(typeof input.text === "string" && input.text.trim()))
        fail("text", "请粘贴招聘正文，或填写公开网页链接。");
      try {
        const host = new URL(input.url).hostname;
        if (
          /(^|\.)(mp.weixin.qq.com|weibo.com|weibo.cn|douyin.com)$/.test(
            host,
          ) &&
          !input.text?.trim()
        )
          fail("text", "该社交平台需粘贴招聘正文，链接用于保留来源。");
      } catch {}
      break;
    }
    case "site":
      ident("providerId", input.providerId, true, false, options.sourceIds);
      ident("siteId", input.siteId, true);
      if (options.siteIds?.includes(input.siteId))
        fail("siteId", "该站点编号已存在，请换一个编号。");
      text("name", input.name, 200, true);
      url("origin", input.origin, true, true);
      url("evidenceUrl", input.evidenceUrl, true, true);
      break;
    case "sourceConfig":
      if (own(input, "enabled") && typeof input.enabled !== "boolean")
        fail("enabled", "启用状态必须为是或否。");
      break;
    case "run":
      ident(
        "targetRevisionId",
        input.targetRevisionId,
        true,
        true,
        options.targetRevisionIds,
      );
      choice("mode", input.mode || "rules", ["rules", "ai", "auto"], true);
      if ((input.mode || "rules") !== "rules")
        key("userApiKey", input.userApiKey);
      break;
    case "preview":
      if (input.file) {
        if (!/\.(txt|md|docx|pdf)$/i.test(input.file.name || ""))
          fail("file", "请选择 TXT、MD、DOCX 或 PDF 文件。");
        if (!input.file.size || input.file.size > 20 * 1024 * 1024)
          fail("file", "文件不能为空，且不能超过 20 MB。");
      } else {
        text("resumeText", input.resumeText, 60000, true);
        if (
          typeof input.resumeText === "string" &&
          input.resumeText.trim().length < 30
        )
          fail("resumeText", "简历正文至少需要 30 个字符。");
      }
      break;
    case "backup":
      if (!input.file) fail("file", "请选择要恢复的 JSON 备份文件。");
      else if (
        !/\.json$/i.test(input.file.name || "") ||
        !input.file.size ||
        input.file.size > 38 * 1024 * 1024
      )
        fail("file", "请选择非空的 JSON 备份文件，大小不超过 38 MB。");
      break;
    case "export":
      choice("format", input.format, ["json", "csv", "md"], true);
      break;
    case "login":
      if (typeof input.password !== "string" || !input.password)
        fail("password", "请输入访问密码。");
      else if (
        input.password.length > 1024 ||
        /[\u0000-\u001f\u007f]/.test(input.password)
      )
        fail("password", "密码不能超过 1024 个字符，且不能包含控制字符。");
      break;
    default:
      fail("_form", "不支持此填写项目。");
  }
  return errors;
}
export function assertInput(kind, input, options) {
  const errors = validateInput(kind, input, options);
  if (Object.keys(errors).length) throw inputError(errors);
  return input;
}
