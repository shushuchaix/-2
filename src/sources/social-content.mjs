import { parseHTML } from "linkedom";
import {
  publicCollectionUrl,
  platformPolicy,
  allowsRoute,
} from "../../electron/collection/network-policy.mjs";
import { classifyRecruitmentIntent } from "./social-intent.mjs";
const challenge =
  /(?:id=["'](?:captcha|verify)|<title>[^<]*(?:安全验证|验证码|登录)|访问过于频繁|环境异常|请完成验证)/i;
const safeDate = (value) => {
  const n = Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};
export function canonicalSocialUrl(value, platform) {
  const u = new URL(value);
  u.hash = "";
  // Remove navigation metadata only; authentication parameters remain rejected.
  for (const key of [
    "scene",
    "subscene",
    "clicktime",
    "enterid",
    "from",
    "isappinstalled",
    "wechat_redirect",
  ])
    u.searchParams.delete(key);
  if (!allowsRoute(u.href, platformPolicy(platform)))
    throw Object.assign(Error("公开文章地址不适用于该来源。"), {
      code: "collection_route_forbidden",
    });
  return publicCollectionUrl(u.href).href;
}
function doc(html) {
  const { document } = parseHTML(String(html || ""));
  for (const node of document.querySelectorAll(
    "script,style,template,iframe,[hidden],[aria-hidden='true']",
  ))
    node.remove();
  for (const node of document.querySelectorAll("[style]"))
    if (
      /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\s*;|\s*$)/i.test(
        node.getAttribute("style"),
      )
    )
      node.remove();
  return document;
}
const plain = (html) =>
  doc("<main>" + String(html || "") + "</main>")
    .querySelector("main")
    .textContent.trim();
function linksAndImages(root, url) {
  const links = [],
    images = [];
  for (const a of root?.querySelectorAll("a[href]") || []) {
    try {
      const u = publicCollectionUrl(new URL(a.getAttribute("href"), url).href);
      if (u.protocol === "https:")
        links.push({ url: u.href, label: a.textContent.trim() });
    } catch {}
  }
  for (const img of root?.querySelectorAll("img") || []) {
    try {
      const u = publicCollectionUrl(
        new URL(img.getAttribute("data-src") || img.getAttribute("src"), url)
          .href,
      );
      if (u.protocol === "https:")
        images.push({ url: u.href, sequence: images.length });
    } catch {}
  }
  return {
    externalLinks: [...new Map(links.map((l) => [l.url, l])).values()],
    images,
  };
}
export function parseWechatContent({ html = "", url, status = 200 }) {
  const canonical = canonicalSocialUrl(url, "wechat"),
    u = new URL(canonical),
    d = doc(html),
    root = d.querySelector("#js_content");
  const description = root?.textContent.trim() || "",
    title =
      d.querySelector("#activity-name")?.textContent.trim() ||
      d.querySelector("title")?.textContent.trim() ||
      "公众号文章";
  const ct = html.match(/\bct\s*[=:]\s*["']?(\d{10})/)?.[1];
  const bodyStatus = [401, 403, 429].includes(status)
    ? "restricted"
    : challenge.test(html)
      ? "challenge_required"
      : status === 200 &&
          root &&
          (description || root.querySelector("img[data-src],img[src]"))
        ? "complete"
        : "incomplete";
  return {
    sourceRecordId:
      u.searchParams.get("mid") && u.searchParams.get("__biz")
        ? [
            u.searchParams.get("__biz"),
            u.searchParams.get("mid"),
            u.searchParams.get("idx") || "1",
          ].join(":")
        : u.pathname.split("/").filter(Boolean).at(-1),
    title,
    description: description || null,
    account: d.querySelector("#js_name")?.textContent.trim() || null,
    company: null,
    cities: [],
    deadlineAt: null,
    publishedAt: ct ? new Date(Number(ct) * 1000).toISOString() : null,
    url: canonical,
    bodyStatus,
    retryEligible: bodyStatus !== "complete",
    ...linksAndImages(root, canonical),
    intent: classifyRecruitmentIntent({ text: title + "\n" + description })
      .intent,
  };
}
export function parseWeiboContent({
  post,
  longText,
  html = "",
  url,
  status = 200,
}) {
  const canonical = canonicalSocialUrl(url, "weibo"),
    d = doc(html);
  const rawFull =
    longText?.longTextContent ||
    longText?.data?.longTextContent ||
    post?.longText?.longTextContent;
  const description = rawFull
    ? plain(rawFull)
    : post
      ? plain(post.text || post.text_raw || "")
      : d.querySelector(".weibo-text")?.textContent.trim() || "";
  const incomplete =
    (post?.isLongText && !rawFull) ||
    (!post && /展开全文|全文\s*$|[.…]{2,}\s*$/.test(description));
  const bodyStatus = [401, 403, 429].includes(status)
    ? "restricted"
    : challenge.test(html)
      ? "challenge_required"
      : description && !incomplete && status === 200
        ? "complete"
        : "incomplete";
  const media = linksAndImages(d.querySelector(".weibo-text"), canonical);
  for (const pic of post?.pics || []) {
    try {
      const imageUrl = publicCollectionUrl(pic.large?.url || pic.url).href;
      if (!media.images.some((i) => i.url === imageUrl))
        media.images.push({ url: imageUrl, sequence: media.images.length });
    } catch {}
  }
  for (const m of description.matchAll(/https:\/\/[^\s<>"']+/g)) {
    try {
      const link = publicCollectionUrl(m[0]).href;
      if (!media.externalLinks.some((i) => i.url === link))
        media.externalLinks.push({ url: link, label: "正文链接" });
    } catch {}
  }
  return {
    sourceRecordId: String(
      post?.idstr || post?.id || new URL(canonical).pathname.split("/").at(-1),
    ),
    title: description.slice(0, 80) || "微博正文",
    description: description || null,
    account: post?.user?.screen_name || null,
    accountId: post?.user?.idstr || post?.user?.id || null,
    originalPostId: post?.retweeted_status
      ? String(post.retweeted_status.idstr || post.retweeted_status.id)
      : null,
    isLongText: !!post?.isLongText,
    company: null,
    cities: [],
    deadlineAt: null,
    publishedAt: safeDate(post?.created_at),
    url: canonical,
    bodyStatus,
    retryEligible: bodyStatus !== "complete",
    ...media,
    intent: classifyRecruitmentIntent({ text: description }).intent,
  };
}
export function parseWechatList(html, url) {
  const d = doc(html),
    articleUrls = [];
  for (const a of d.querySelectorAll("a[href]"))
    try {
      const u = canonicalSocialUrl(
        new URL(a.getAttribute("href"), url).href,
        "wechat",
      );
      if (new URL(u).pathname.match(/^\/s(?:\/|$)/) && !articleUrls.includes(u))
        articleUrls.push(u);
    } catch {}
  return { articleUrls, hasMore: false, coverageScope: "limited" };
}
export function parseWeiboList(payload) {
  const data = payload?.data || payload || {},
    posts = [];
  const visit = (cards) => {
    for (const card of cards || []) {
      if (card.mblog) posts.push(card.mblog);
      if (card.card_group) visit(card.card_group);
    }
  };
  visit(data.cards);
  for (const post of data.list || data.statuses || []) posts.push(post);
  return {
    posts,
    nextSinceId: data.cardlistInfo?.since_id || data.since_id || null,
  };
}
export function parseSocialResponse({ platform, url, status, text }) {
  if (platform === "wechat")
    return parseWechatContent({ url, status, html: text });
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {}
  return parseWeiboContent({
    url,
    status,
    html: payload ? "" : text,
    post:
      payload?.data?.text !== undefined
        ? payload.data
        : payload?.data?.status || payload?.status,
    longText: payload?.data?.longTextContent ? payload.data : undefined,
  });
}
