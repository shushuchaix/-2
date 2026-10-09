// 微信公众号公告 → 结构化岗位
//
// 公众号文章是散文体：一篇可能是单公司公告，也可能是「9月校招信息汇编」这种多公司合集，
// 甚至还可能只是经验分享。因此必须让 LLM 判断体裁并逐岗位抽取，不能假定「一文一岗」。
import { chunk, normKey, pool, sanitizeText, truncate } from "../util/text.mjs";
import { normalizeDate } from "../util/html.mjs";
import { extractTechTerms } from "../util/skills.mjs";
import { recordDiagnostic } from "../infrastructure/diagnostics/log.mjs";
import { articleParts } from "../sources/content-queue.mjs";

const SYSTEM = `你是招聘信息抽取助手，负责从中文微信公众号文章中抽取校园招聘 / 实习岗位。

严格规则：
1. 只抽取文章里**明确写出**的信息，绝不编造公司名、城市、学历、薪资或截止时间；未提及的一律留空字符串。
2. 先判断体裁：经验分享、行业资讯、求职鸡汤、培训广告、活动通知等都**不是**招聘公告，此时 isRecruiting=false 且 positions 为空数组。
3. 一篇文章可能汇总多家公司的岗位（如「校招信息汇编」）。此时要逐个岗位给出各自的 company；若整篇只讲一家公司，company 可留空，由外部沿用文章级公司名。
4. 逐一抽取当前正文片段内所有明确岗位，不以固定岗位数量截断。**如果文章只写了「招聘岗位详见附件 / 详见招聘简章」而没有列出任何具体岗位名称，就把 positions 留空**，不要把指引语当成岗位名。
5. summary 用一句话概括该岗位的关键要求（60 字以内），不要照抄整段。
6. 严格输出 JSON，不要任何解释或 Markdown 围栏。`;

const SCHEMA = `{
  "isRecruiting": true,
  "company": "文章主体的招聘公司名（若为多公司汇总可留空）",
  "batch": "招聘批次，如 2026届秋季校园招聘",
  "deadline": "截止时间，如 2025-10-31；未提及留空",
  "applyMethod": "投递方式概述，如「官网网申」「邮箱投递」「扫码投递」，60 字以内",
  "positions": [
    {
      "company": "该公司名（多公司汇总时必填；单公司时留空）",
      "title": "岗位名称",
      "city": "工作城市",
      "education": "学历要求",
      "major": "专业要求",
      "experience": "经验要求，如「3年以上」「应届生」「经验不限」；未提及留空",
      "jobType": "校招 | 实习 | 社招 | 未说明（依据文章措辞判断，不要一律填校招）",
      "salary": "薪资，未提及留空",
      "headcount": "招聘人数，未提及留空",
      "summary": "该岗位关键要求，60 字以内",
      "requirementsExcerpt": "对应岗位要求的正文原文，逐字摘录，不能改写"
    }
  ]
}`;

/**
 * 判断这篇文章值不值得调用 LLM
 * 纯图片海报（校招公告常见）正文极短但图很多，LLM 也读不出内容，直接用标题作为线索
 */
export function triageArticle(article) {
  const text = article.description || "";
  const images = article.extra?.imageCount || 0;
  if (!article.url) return { expandable: false, reason: "未取到文章地址" };
  if (article.extra?.unavailable)
    return { expandable: false, reason: article.extra.unavailable };
  if (text.length < 120 && images >= 3)
    return {
      expandable: false,
      reason: `纯图片公告（${images} 张图，${text.length} 字）`,
    };
  if (text.length < 120)
    return { expandable: false, reason: `正文过短（${text.length} 字）` };
  return { expandable: true, reason: "" };
}

/**
 * 过滤掉不是真岗位的「占位标题」。
 *
 * LLM 面对「招聘岗位详见附件」这类汇总文章时，容易把指引语当成岗位名，
 * 于是产出「详见招聘简章」「点击查看详情」这种没有信息量的条目。
 */
const PLACEHOLDER_TITLE =
  /^(详见|见附件|点击|查看|更多|其他|若干|详情|附件|招聘简章|招聘详情|公告原文|阅读原文|扫码|见下表|如下|待定|不限)/;

export function isPlaceholderTitle(title) {
  const t = sanitizeText(title);
  if (!t || t.length < 2) return true;
  if (PLACEHOLDER_TITLE.test(t)) return true;
  if (
    /^(详见|参见|点击|查看)/.test(t) &&
    /简章|详情|附件|链接|原文|公告/.test(t)
  )
    return true;
  return false;
}

/** 岗位条目 → 统一 Job 结构 */
function positionToJob(article, pos, articleResult) {
  const company =
    sanitizeText(pos.company) || sanitizeText(articleResult.company) || "";
  const account = article.extra?.account || "";
  const title = sanitizeText(pos.title) || article.title;
  // 岗位类型以文章实际措辞为准：公众号里混着大量社招，一律按标题猜「校招」会误导应届生
  const rawType = sanitizeText(pos.jobType);
  const jobType =
    /实习/.test(rawType) || /实习/.test(title)
      ? "实习"
      : /校招|校园|应届/.test(rawType) || /校招|校园招聘|应届/.test(title)
        ? "校招"
        : /社招|社会招聘/.test(rawType)
          ? "社招"
          : "";
  const extra = {
    account,
    articleTitle: article.extra?.articleTitle || article.title,
    batch: sanitizeText(articleResult.batch),
    deadline:
      normalizeDate(articleResult.deadline || "") ||
      sanitizeText(articleResult.deadline),
    applyMethod: sanitizeText(articleResult.applyMethod),
    headcount: sanitizeText(pos.headcount),
    major: sanitizeText(pos.major),
    fromArticle: true,
  };

  // 公众号岗位没有招聘站那样的技能标签字段。若留空，规则预筛的技能维度会得 0 分，
  // 在 400+ 条岗位里会被系统性压低而进不了短名单（实习僧当初踩过同样的坑）。
  // 这里只从「该岗位自身」的字段反推，不掺入整篇正文，避免多公司汇总文章里技能张冠李戴。
  const skills = extractTechTerms(
    [
      title,
      company,
      pos.requirementsExcerpt,
      sanitizeText(pos.major),
      sanitizeText(pos.summary),
      sanitizeText(pos.education),
    ]
      .filter(Boolean)
      .join(" "),
  );

  return {
    id: `${article.sourceId || article.source || "wechat"}:${normKey(company)}|${normKey(title)}|${normKey(pos.city)}`,
    source: article.sourceId || article.source || "wechat",
    sourceName: `${article.sourceName}`,
    sources: [article.sourceId || article.source || "wechat"],
    title,
    company,
    city: sanitizeText(pos.city),
    district: "",
    salary: sanitizeText(pos.salary),
    education: sanitizeText(pos.education),
    // 经验要求会参与「应届生适配度」评分：写明 3 年以上的岗位会被显著降权
    experience: sanitizeText(pos.experience),
    jobType,
    skills,
    tags: [
      ...(extra.batch ? [extra.batch] : []),
      ...(extra.deadline ? [`截止 ${extra.deadline}`] : []),
      ...(account ? [`公众号：${account}`] : []),
    ],
    publishTime: article.publishTime || "",
    url: article.url,
    summary: sanitizeText(pos.summary),
    description: buildDescription(article, pos, extra),
    extra,
    fromArticle: true,
    articleUrl: article.url,
  };
}

function buildDescription(article, pos, extra) {
  const lines = [];
  lines.push(
    `【来源】微信公众号「${extra.account || "未知"}」：${extra.articleTitle}`,
  );
  if (extra.batch) lines.push(`【批次】${extra.batch}`);
  if (extra.applyMethod) lines.push(`【投递方式】${extra.applyMethod}`);
  if (extra.deadline) lines.push(`【截止时间】${extra.deadline}`);
  const details = [
    pos.city ? `工作城市：${sanitizeText(pos.city)}` : "",
    pos.education ? `学历要求：${sanitizeText(pos.education)}` : "",
    pos.major ? `专业要求：${sanitizeText(pos.major)}` : "",
    pos.salary ? `薪资：${sanitizeText(pos.salary)}` : "",
    pos.headcount ? `招聘人数：${sanitizeText(pos.headcount)}` : "",
  ].filter(Boolean);
  if (details.length) lines.push(`【岗位信息】${details.join("；")}`);
  if (pos.summary) lines.push(`【要求概述】${sanitizeText(pos.summary)}`);
  // 附上原文片段，便于人工核对
  const excerpt = truncate(
    (article.description || "").replace(/\s+/g, " "),
    900,
  );
  if (excerpt) lines.push(`【公告原文摘录】${excerpt}`);
  return lines.join("\n");
}

/**
 * 批量把公众号文章展开为结构化岗位
 * @returns {{ jobs: object[], expanded: number, skipped: number, noJob: number }}
 */
export async function expandArticles(
  llm,
  _profile,
  articles,
  {
    maxExpand = Infinity,
    concurrency = 3,
    log = () => {},
    signal,
    diagnostics,
    diagnosticContext = {},
  } = {},
) {
  const candidates = articles
    .slice(0, maxExpand)
    .flatMap((article) =>
      articleParts(article.description || "").map((description) => ({
        ...article,
        description,
      })),
    );
  if (candidates.length === 0)
    return { jobs: [], expanded: 0, skipped: 0, noJob: 0, failed: 0 };

  const jobs = [];
  let expanded = 0;
  let noJob = 0;
  let done = 0;
  let failed = 0;

  await pool(candidates, concurrency, async (article) => {
    try {
      signal?.throwIfAborted();
      const text = article.description || "";
      const res = await llm.chatJson(
        SYSTEM,
        `## 文章标题\n${article.title}\n\n## 公众号\n${article.extra?.account || "未知"}\n\n## 文章正文\n${text}\n\n请按下面结构输出 JSON：\n${SCHEMA}`,
        {
          temperature: 0.1,
          maxTokens: 4000,
          signal,
          diagnosticContext,
          repair: false,
        },
      );

      if (
        !res ||
        res.isRecruiting === false ||
        !Array.isArray(res.positions) ||
        res.positions.length === 0
      ) {
        noJob++;
        article.extra = {
          ...(article.extra || {}),
          expandedResult: "not_recruiting",
        };
        return;
      }

      const usable = res.positions.filter(
        (p) => p && !isPlaceholderTitle(p.title),
      );
      const dropped = res.positions.length - usable.length;
      if (usable.length === 0) {
        // 整篇都是「详见招聘简章」这类指引语，说明文章只给了线索没给岗位
        noJob++;
        article.extra = {
          ...(article.extra || {}),
          expandedResult: "no_concrete_position",
          dropped,
        };
        return;
      }
      for (const p of usable) {
        if (
          typeof p.title !== "string" ||
          !text.includes(p.title) ||
          typeof p.requirementsExcerpt !== "string" ||
          !p.requirementsExcerpt.trim() ||
          !text.includes(p.requirementsExcerpt)
        )
          continue;
        // Model output is untrusted. Keep a fact only when its literal value
        // occurs in the source; an instruction in the prompt is not validation.
        const literal = (value) => {
          const clean = typeof value === "string" ? sanitizeText(value) : "";
          return clean && text.includes(clean) ? clean : "";
        };
        const verified = {
          ...p,
          ...Object.fromEntries(
            [
              "company",
              "city",
              "education",
              "major",
              "experience",
              "jobType",
              "salary",
              "headcount",
              "summary",
            ].map((field) => [field, literal(p[field])]),
          ),
        };
        const verifiedArticle = Object.fromEntries(
          ["company", "batch", "deadline", "applyMethod"].map((field) => [
            field,
            literal(res[field]),
          ]),
        );
        const derived = positionToJob(article, verified, verifiedArticle);
        jobs.push({
          ...derived,
          sourceId: article.sourceId,
          siteId: article.siteId,
          identityScope: article.identityScope,
          sourceRecordId:
            String(article.sourceRecordId || article.url) +
            ":position:" +
            normKey(
              p.title +
                " " +
                (verified.company || verifiedArticle.company || "") +
                " " +
                (verified.city || ""),
            ),
          kind: "job",
          bodyStatus: article.bodyStatus,
          publishedAt: article.publishedAt,
          deadlineAt: verifiedArticle.deadline || null,
          applyUrl: article.applyUrl || null,
          parserVersion: "article-literal-2",
          sourceRecordIdKind: "generated",
          urlKind: "notice_detail",
          description: p.requirementsExcerpt,
          derivedFrom: article.sourceRecordId || article.url,
          evidence: [
            { field: "title", excerpt: p.title, url: article.url },
            {
              field: "description",
              excerpt: p.requirementsExcerpt,
              url: article.url,
            },
          ],
        });
      }
      expanded++;
      article.extra = {
        ...(article.extra || {}),
        expandedResult: "ok",
        positions: usable.length,
        dropped,
      };
      log(
        `  「${truncate(article.extra?.articleTitle || article.title, 28)}」抽出 ${usable.length} 个岗位` +
          (dropped ? `（过滤掉 ${dropped} 条占位描述）` : ""),
      );
    } catch (e) {
      if (
        signal?.aborted ||
        [
          "model_budget_exhausted",
          "collection_stale_epoch",
          "workspace_write_failed",
        ].includes(e.code)
      )
        throw e;
      failed++;
      await recordDiagnostic(
        diagnostics,
        {
          operation: "model.fallback",
          ...diagnosticContext,
          sourceId: article.sourceId,
          siteId: article.siteId,
          phase: e.phase || "response",
          outcome: "partial",
          code: e.code || "article_model_unavailable",
          counts: { failed: 1 },
          requestId: e.requestId,
        },
        e,
      );
      article.extra = {
        ...(article.extra || {}),
        expandedResult: "failed",
      };
      log(`  文章抽取失败：${e.message}`);
    } finally {
      done++;
      if (done % 3 === 0 || done === candidates.length)
        log(`公众号文章抽取进度 ${done}/${candidates.length}`);
    }
  });

  return {
    jobs: [...new Map(jobs.map((job) => [job.sourceRecordId, job])).values()],
    expanded,
    skipped: articles.length - candidates.length,
    noJob,
    failed,
  };
}

export { chunk };
