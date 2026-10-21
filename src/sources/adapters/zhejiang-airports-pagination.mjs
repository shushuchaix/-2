import { parse } from "acorn";
import { parseHTML } from "linkedom";
import { explicitDate } from "../../util/html-elements.mjs";

const origin = "https://www.zjairports.com";
const listUrl = origin + "/newRecruitment.html";
const apiPath = "/newRecruitmentPage.html";
const fail = (code) => {
  throw Object.assign(Error(code), { code, retryable: false });
};
const endpoint = (page) =>
  `${origin}${apiPath}?id=31&pageSize=10&page=${page}`;
export function isZhejiangPaginationConfigured(site) {
  return Boolean(
    site?.siteId === "official-d80ddfbc91795a1f" &&
      site.providerId === "official-announcements" &&
      site.origin === origin &&
      site.allowedDomains?.includes("www.zjairports.com") &&
      site.template?.nativePagination === "zjairports-options-1" &&
      site.template.paginationVerified === true &&
      site.template.listUrl === listUrl &&
      site.template.linkRule === ".newsItem02 .cp-block-headline a[href]" &&
      site.template.bodyRule === ".detailContent" &&
      site.template.pathPrefix === "/newRecruitmentInfo.html",
  );
}
function optionsFrom(html) {
  const { document } = parseHTML(html);
  const found = [];
  for (const node of document.querySelectorAll("script:not([src])")) {
    if (
      node.closest("template,noscript") ||
      !["", "text/javascript", "application/javascript"].includes(
        (node.getAttribute("type") || "").toLowerCase(),
      ) ||
      !node.textContent.includes("OPTIONS")
    )
      continue;
    let ast;
    try {
      ast = parse(node.textContent, { ecmaVersion: "latest" });
    } catch {
      fail("native_transport_contract_mismatch");
    }
    for (const statement of ast.body) {
      if (statement.type !== "VariableDeclaration" || statement.kind !== "var")
        continue;
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== "Identifier" || declaration.id.name !== "OPTIONS")
          continue;
        const object = declaration.init;
        if (object?.type !== "ObjectExpression")
          fail("native_transport_contract_mismatch");
        const value = {};
        for (const property of object.properties) {
          const key = property.key?.name ?? property.key?.value;
          if (
            property.type !== "Property" ||
            property.kind !== "init" ||
            property.computed ||
            property.method ||
            !["id", "listApiUrl", "pageSize", "total"].includes(key) ||
            Object.hasOwn(value, key) ||
            property.value.type !== "Literal"
          )
            fail("native_transport_contract_mismatch");
          value[key] = property.value.value;
        }
        found.push(value);
      }
    }
  }
  const value = found[0];
  if (
    found.length !== 1 ||
    value.id !== 31 ||
    value.listApiUrl !== apiPath ||
    value.pageSize !== 10 ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    value.total > 100000
  )
    fail("native_transport_contract_mismatch");
  return value;
}
export async function readZhejiangNoticePage(site, page, ctx) {
  if (!isZhejiangPaginationConfigured(site)) fail("template_not_configured");
  let url = listUrl,
    total;
  if (page > 1) {
    const cursor = ctx.cursor;
    if (
      !cursor ||
      Object.keys(cursor).some((key) => !["page", "url", "total"].includes(key)) ||
      cursor.page !== page ||
      cursor.url !== endpoint(page) ||
      !Number.isSafeInteger(cursor.total) ||
      cursor.total < 0 ||
      cursor.total > 100000 ||
      (page - 1) * 10 >= cursor.total
    )
      fail("collection_cursor_invalid");
    url = cursor.url;
    total = cursor.total;
  }
  const response = await ctx.request(url, { signal: ctx.signal });
  if ([401, 403].includes(response.status)) fail("restricted");
  if (response.status !== 200) fail("http_error");
  if (response.url && response.url !== url) fail("detail_identity_mismatch");
  if (page === 1) total = optionsFrom(response.text).total;
  return { response, url, total, page };
}
export function zhejiangNoticeCursor(page, rowCount) {
  const expected = Math.min(10, page.total - (page.page - 1) * 10);
  if (rowCount !== expected) fail("native_transport_contract_mismatch");
  return page.page * 10 < page.total
    ? { page: page.page + 1, url: endpoint(page.page + 1), total: page.total }
    : null;
}
export function zhejiangNoticeDate(row) {
  const day = row?.querySelector(".date .day")?.textContent.trim();
  const month = [...(row?.querySelectorAll(".date span:not(.day)") || [])]
    .map((node) => node.textContent.trim())
    .find((value) => /^20\d{2}-\d{2}$/.test(value));
  return /^\d{1,2}$/.test(day || "") && month
    ? explicitDate(`${month}-${day}`)
    : null;
}
export function assertZhejiangNoticeRecord(site, record) {
  if (!isZhejiangPaginationConfigured(site)) fail("template_not_configured");
  let url;
  try {
    url = new URL(record.url);
  } catch {
    fail("detail_identity_mismatch");
  }
  if (
    record.siteId !== site.siteId ||
    record.sourceId !== site.providerId ||
    record.identityScope !== site.siteId ||
    record.kind !== "recruitment_notice" ||
    url.origin !== origin ||
    url.pathname !== "/newRecruitmentInfo.html" ||
    url.hash ||
    [...url.searchParams.keys()].length !== 1 ||
    !/^[1-9]\d*$/.test(url.searchParams.get("id") || "")
  )
    fail("detail_identity_mismatch");
}
export function assertZhejiangNoticeDetail(site, record, response, document) {
  assertZhejiangNoticeRecord(site, record);
  if (response.url && response.url !== record.url) fail("detail_identity_mismatch");
  const titles = [...document.querySelectorAll("h1.detailTitle")];
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  if (titles.length !== 1 || normalize(titles[0].textContent) !== normalize(record.title))
    fail("detail_title_mismatch");
}
