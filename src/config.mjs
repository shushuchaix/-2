// 配置加载与密钥解析
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * 可写数据目录。
 *
 * 打包成桌面应用后代码位于只读的 app.asar 内，不能往旁边写文件，
 * 因此数据目录必须可重定向 —— Electron 主进程用 RJR_DATA_DIR 指向用户数据目录。
 * 源码方式运行时仍默认落在项目下的 data/，行为保持不变。
 */
export function resolveDataRoot() {
  return process.env.RJR_DATA_DIR
    ? path.resolve(process.env.RJR_DATA_DIR)
    : path.join(ROOT, "data");
}
export const DATA_ROOT = resolveDataRoot();

/** 是否运行在桌面应用外壳里 */
export const IS_DESKTOP = process.env.RJR_DESKTOP === "1";

/** 配置优先读数据目录（用户可写），退回代码目录（随包自带的默认值） */
export function resolveConfigPath(
  dataDir = process.env.RJR_DATA_DIR
    ? path.resolve(process.env.RJR_DATA_DIR)
    : DATA_ROOT,
) {
  const inData = path.join(dataDir, "config.json");
  if (fs.existsSync(inData)) return inData;
  return path.join(ROOT, "config.json");
}

export const CONFIG_PATH = resolveConfigPath();
export const EXAMPLE_PATH = path.join(ROOT, "config.example.json");

export const DEFAULT_CONFIG = {
  network: { dnsMode: "auto" },
  deepseek: {
    apiKey: "",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    concurrency: 4,
    timeoutMs: 120000,
    // 允许访客自带 DeepSeek Key（公网多用户部署时强烈建议开启，成本由使用者自担）
    allowUserKey: true,
  },
  search: {
    // auto = 按已配置的 key 自动选择；none = 关闭全网搜索通道
    provider: "auto",
    tavilyApiKey: "",
    serperApiKey: "",
    bochaApiKey: "",
  },
  sources: {
    coverageMode: "standard",
    v2Budgets: {
      maxSites: 12,
      maxRequests: 120,
      maxKeywords: 6,
      maxPagesPerQuery: 2,
      maxDetails: 20,
    },
    zhaopin: { enabled: true, maxPages: 3, delayMs: 600 },
    shixiseng: {
      enabled: true,
      maxPages: 3,
      delayMs: 800,
      titleRepairSamples: 8,
    },
    searchApi: { enabled: true, maxQueries: 6, resultsPerQuery: 10 },
    // 微信公众号校招公告（经搜狗微信公开通道，无需登录微信）
    wechat: {
      enabled: true,
      maxPages: 1, // 搜狗每页 10 条，翻页过多易触发反爬
      maxFetch: 10, // 最多解析链接并抓正文的篇数
      maxExpand: 6, // 最多交给 LLM 抽取岗位的篇数
      maxQueries: 4,
      delayMs: 1200,
    },
    // 牛客校招：岗位带结构化 graduationYear 字段，按届别筛选最准
    nowcoder: { enabled: true, includeSchedule: true, maxSchedule: 6 },
    // 高校就业网：企业把官方校招信息发布到这里，页面可解析
    // （企业自研校招官网几乎都是 SPA + 需鉴权接口，抓不到）
    university: {
      enabled: true,
      maxHosts: 4,
      maxPerKeyword: 12,
      maxDetail: 12,
      delayMs: 900,
      // 追加自己学校的就业网：[{ "name": "XX大学", "host": "https://job.xx.edu.cn" }]
      hosts: [],
    },
    // 晨云智慧就业管理服务系统（与才立方是两套不同系统，如中国民用航空飞行学院）
    // 列表接口必须 POST /index/index/employjoblistdata.html，且不支持关键词过滤 → 全量翻页后本地排序
    chenyun: {
      enabled: true,
      maxHosts: 2,
      maxPages: 6,
      maxDetail: 12,
      delayMs: 800,
      hosts: [],
    },
    // 就业桥：按学校开子域的商用平台（{abbr}.jiuyeqiao.cn），实测 20/20 覆盖，
    // 含大量自建就业网抓不到的院校。岗位库跨校，支持服务端关键词过滤。
    jiuyeqiao: {
      enabled: true,
      maxPerKeyword: 10,
      maxPages: 1,
      maxDetail: 8,
      delayMs: 700,
    },
    // 覆盖多少个期望城市；首选城市跑全部关键词，其余城市各跑前 N 个关键词
    maxCities: 2,
    secondaryCityKeywords: 2,
  },
  match: {
    shortlistSize: 60,
    enrichTopN: 12,
    scoreBatchSize: 8,
    minScore: 40,
  },
  // 求职目标过滤：只保留面向指定届别的校招岗位
  filters: {
    // 目标毕业届别，如 "2027"。留空表示不做届别过滤。
    graduationYear: "",
    // 是否保留实习岗。默认关闭 —— 「校招」与「实习」是两类岗位，
    // 混在一起时实习岗会因数量庞大挤掉真正的校招岗。
    includeInternship: false,
    // 例外：明确写了「可转正 / 留用」的实习继续保留。
    // 「只实习不转正」和「可转正实习」价值完全不同 —— 前者对找正式岗的人是白干，后者是入职通道。
    keepConvertibleInternship: true,
    // 学历下限：排除**明确要求低于自己学历**的岗位（本科求职者不看「大专及以上」）。
    // 学历不限 / 未标注 / 要求高于自己学历的，都保留。
    excludeBelowDegree: true,
    // 手动指定学历下限（留空 = 按简历里的学历推断）
    minDegree: "",
    // true = 硬过滤（不符合就剔除）；false = 仅记录标记、不剔除
    strict: true,
    // 用几个「届别」检索词去招聘站搜校招岗（越多召回越高，也越慢）
    yearQueryCount: 3,
    // 期望城市：
    //   null        = 从简历推断（默认）
    //   []          = 不限城市，全国范围检索
    //   ["北京","上海"] = 指定城市
    cities: null,
  },
  // 求职画像「钉死」覆盖：填了就覆盖简历解析出来的对应字段。
  // 用途：把工具固定服务于某个特定目标（某校某专业），不受 LLM 抽取波动影响。
  // 例：{ "school": "中国民用航空飞行学院", "major": "消防工程", "targetRoles": ["消防工程师"] }
  profile: {},
  auth: {
    // password = 需要登录（公网部署必须）；none = 完全开放（仅在明确知情时使用）
    mode: "password",
    passwordHash: "",
    sessionTtlHours: 168,
    maxLoginFails: 5,
    lockMinutes: 15,
  },
  limits: {
    maxConcurrent: 2,
    maxQueue: 8,
    dailyGlobal: 100,
    dailyPerIp: 10,
    perIpCooldownMs: 30000,
  },
  server: {
    port: 3210,
    host: "127.0.0.1",
    // 部署在 nginx/Caddy 之后时置为 true，否则不要开：否则 X-Forwarded-For 可被伪造绕过限流
    trustProxy: false,
    publicUrl: "",
  },
};

function deepMerge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base) || typeof base !== "object") return over;
  if (typeof over !== "object" || Array.isArray(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 读取 DSH 凭据文件中的 DEEPSEEK_API_KEY（若存在） */
function deepseekKeyFromDshHome() {
  const homes = [process.env.DSH_HOME, path.join(os.homedir(), ".dsh")].filter(
    Boolean,
  );
  for (const home of homes) {
    const file = path.join(home, ".credentials.yaml");
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      const m = text.match(/DEEPSEEK_API_KEY:\s*["']?([^\s"']+)/);
      if (m && m[1]) return m[1];
    } catch {
      /* 忽略 */
    }
  }
  return "";
}

/**
 * 判断配置里的密钥是不是「占位符」。
 * config.example.json 里写的是提示文案，若不做识别，
 * 用户从它复制出 config.json 后会得到一个「看起来已配置、实际不可用」的密钥，
 * 并且会覆盖掉环境变量 / DSH 凭据的自动探测。
 */
function isPlaceholderKey(k = "") {
  const s = String(k).trim();
  if (!s) return true;
  return /填入|你的|请填|在这里|your[-_ ]?key|placeholder|xxxx|todo/i.test(s);
}

export function loadConfig({ quiet = false, dataDir } = {}) {
  let userCfg = {};
  const configPath = resolveConfigPath(dataDir);
  if (fs.existsSync(configPath)) {
    try {
      userCfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      if (!quiet)
        console.warn(
          `[config] config.json 解析失败，使用默认配置：${e.message}`,
        );
    }
  }
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), userCfg);
  if (isPlaceholderKey(cfg.deepseek.apiKey)) cfg.deepseek.apiKey = "";

  // 密钥解析：config.json → 环境变量 → DSH 凭据
  const keySources = [];
  if (cfg.deepseek.apiKey) keySources.push("config.json");
  else if (process.env.DEEPSEEK_API_KEY) {
    cfg.deepseek.apiKey = process.env.DEEPSEEK_API_KEY;
    keySources.push("环境变量 DEEPSEEK_API_KEY");
  } else {
    const fromDsh = deepseekKeyFromDshHome();
    if (fromDsh) {
      cfg.deepseek.apiKey = fromDsh;
      keySources.push("DSH 凭据 (.credentials.yaml)");
    }
  }
  cfg.__deepseekKeySource = keySources[0] || "未找到";

  const searchKeys = {
    tavily: isPlaceholderKey(cfg.search.tavilyApiKey)
      ? process.env.TAVILY_API_KEY || ""
      : cfg.search.tavilyApiKey,
    serper: isPlaceholderKey(cfg.search.serperApiKey)
      ? process.env.SERPER_API_KEY || ""
      : cfg.search.serperApiKey,
    bocha: isPlaceholderKey(cfg.search.bochaApiKey)
      ? process.env.BOCHA_API_KEY || ""
      : cfg.search.bochaApiKey,
  };
  cfg.__searchKeys = searchKeys;
  cfg.__activeSearchProvider = resolveSearchProvider(cfg, searchKeys);

  /* ---------- 环境变量覆盖（容器 / 云平台以环境变量注入配置） ---------- */
  if (process.env.HOST) cfg.server.host = process.env.HOST;
  if (process.env.PORT)
    cfg.server.port = Number(process.env.PORT) || cfg.server.port;
  if (process.env.PUBLIC_URL) cfg.server.publicUrl = process.env.PUBLIC_URL;
  if (/^(1|true|yes|on)$/i.test(process.env.TRUST_PROXY || ""))
    cfg.server.trustProxy = true;
  if (process.env.AUTH_MODE)
    cfg.auth.mode = String(process.env.AUTH_MODE).toLowerCase();
  if (process.env.AUTH_SECRET) cfg.__authSecret = process.env.AUTH_SECRET;
  for (const [env, apply] of [
    ["DAILY_LIMIT", (v) => (cfg.limits.dailyGlobal = v)],
    ["IP_DAILY_LIMIT", (v) => (cfg.limits.dailyPerIp = v)],
    ["MAX_CONCURRENT", (v) => (cfg.limits.maxConcurrent = v)],
    ["MAX_QUEUE", (v) => (cfg.limits.maxQueue = v)],
    ["PER_IP_COOLDOWN_MS", (v) => (cfg.limits.perIpCooldownMs = v)],
  ]) {
    const n = Number(process.env[env]);
    if (Number.isFinite(n) && n >= 0) apply(n);
  }

  // 口令：环境变量明文 > config.json 里的哈希。这里只收集，哈希在服务启动时算（避免与 auth.mjs 循环依赖）
  cfg.__envAuthPassword = process.env.AUTH_PASSWORD || "";
  cfg.auth.passwordHash = isPlaceholderKey(cfg.auth.passwordHash)
    ? ""
    : cfg.auth.passwordHash;
  cfg.__authSource = cfg.__envAuthPassword
    ? "环境变量 AUTH_PASSWORD"
    : cfg.auth.passwordHash
      ? "config.json auth.passwordHash"
      : "未配置";

  if (!quiet) {
    console.log(`[config] 工作目录: ${ROOT}`);
    console.log(
      `[config] DeepSeek 密钥来源: ${cfg.__deepseekKeySource}${cfg.deepseek.apiKey ? "" : "（未配置，LLM 功能不可用）"}`,
    );
    console.log(
      `[config] 全网搜索通道: ${cfg.__activeSearchProvider || "未配置（仅使用站点直连通道）"}`,
    );
    console.log(
      `[config] 监听: ${cfg.server.host}:${cfg.server.port}${cfg.server.trustProxy ? "（信任反向代理）" : ""}`,
    );
    console.log(
      `[config] 鉴权: ${cfg.auth.mode === "none" ? "已关闭" : `密码登录（口令来源：${cfg.__authSource}）`}`,
    );
  }
  return cfg;
}

/**
 * 启动前的暴露面安全校验（fail-closed）。
 * 公网监听但没配口令 = 把 API 额度和抓取能力免费开放给全网，必须拒绝启动。
 */
export function assertSafeExposure(cfg) {
  const host = String(cfg.server.host || "");
  const isPublicBind = !["127.0.0.1", "localhost", "::1"].includes(host);
  if (!isPublicBind)
    return { publicBind: false, authEnabled: false, devMode: true };

  if (cfg.auth.mode === "none") {
    if (!/^(1|true|yes|on)$/i.test(process.env.ALLOW_PUBLIC_NO_AUTH || "")) {
      throw new Error(
        "拒绝启动：监听地址为 " +
          host +
          ' 且 auth.mode = "none"，等于把服务完全开放给公网。\n' +
          "  这会让任何人都能消耗你的 DeepSeek 额度、并用你的服务器 IP 去抓取招聘网站。\n" +
          '  请改为 "password" 并设置 AUTH_PASSWORD；若确实要完全开放，请显式设置环境变量 ALLOW_PUBLIC_NO_AUTH=1。',
      );
    }
    return { publicBind: true, authEnabled: false, devMode: false };
  }

  const hasPassword = Boolean(cfg.__envAuthPassword || cfg.auth.passwordHash);
  if (!hasPassword) {
    throw new Error(
      "拒绝启动：监听地址为 " +
        host +
        "（公网/局域网可达），但没有配置登录口令。\n" +
        "  请任选一种方式配置后重启：\n" +
        "    1) 环境变量：AUTH_PASSWORD=你的密码\n" +
        '    2) 生成哈希写入 config.json 的 auth.passwordHash（运行 npm run hash-password -- "你的密码"）\n' +
        "  若只想本机使用，请把 config.json 的 server.host 改回 127.0.0.1。",
    );
  }
  return { publicBind: true, authEnabled: true, devMode: false };
}

export function resolveSearchProvider(cfg, keys = cfg.__searchKeys || {}) {
  const p = (cfg.search.provider || "auto").toLowerCase();
  if (p === "none" || p === "off") return "";
  if (p !== "auto") {
    if (keys[p]) return p;
    return "";
  }
  if (keys.tavily) return "tavily";
  if (keys.bocha) return "bocha";
  if (keys.serper) return "serper";
  return "";
}

export function writeExampleConfig() {
  const example = {
    ...DEFAULT_CONFIG,
    deepseek: { ...DEFAULT_CONFIG.deepseek, apiKey: "sk-你的DeepSeek密钥" },
  };
  fs.writeFileSync(
    EXAMPLE_PATH,
    JSON.stringify(example, null, 2) + "\n",
    "utf8",
  );
}

/**
 * 首次运行时把配置样例复制到可写数据目录（桌面版/重定向数据目录时用）。
 * 网页版的数据目录就是仓库 data/，配置读的是仓库根的 config.json，
 * 所以这里只对「重定向过的数据目录」做种子，避免在仓库里多出一份没人读的 data/config.json。
 */
export function seedConfig(dataDir = resolveDataRoot()) {
  if (dataDir === path.join(ROOT, "data")) return null;
  const target = path.join(dataDir, "config.json");
  if (fs.existsSync(target)) return target;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(EXAMPLE_PATH)) fs.copyFileSync(EXAMPLE_PATH, target);
  } catch {
    /* 复制失败不影响运行，用户仍可在界面里填自带 Key */
  }
  return target;
}

export function ensureDataDirs({ dataDir = resolveDataRoot() } = {}) {
  const dirs = [
    dataDir,
    path.join(dataDir, "runs"),
    path.join(dataDir, "uploads"),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  seedConfig(dataDir);
  return dirs;
}

export function maskKey(k = "") {
  if (!k) return "(空)";
  if (k.length <= 10) return k.slice(0, 3) + "***";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
