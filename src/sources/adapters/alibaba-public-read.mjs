// Native anonymous page fields, inspected as AST only. The caller must
// obtain this response without account material; nothing is executed or stored.
import { parse } from "acorn";
import { parseHTML } from "linkedom";
import { safeSourceDiagnosticRefs } from "../source-status.mjs";
export const ALIBABA_PUBLIC_LIST = "https://talent.alibaba.com/position/search";
const fail = (contractStage, contractReason) => {
  throw Object.assign(Error("native_transport_contract_mismatch"), {
    code: "native_transport_contract_mismatch",
    contractStage,
    contractReason,
    retryable: false,
  });
};
const key = (p) =>
  p.key?.type === "Identifier"
    ? p.key.name
    : p.key?.type === "Literal"
      ? p.key.value
      : null;
function property(node, name) {
  if (
    node?.type !== "ObjectExpression" ||
    node.properties.some(
      (p) =>
        p.type !== "Property" || p.computed || p.method || p.kind !== "init",
    )
  )
    fail("config_shape", "config_duplicate_or_dynamic");
  const selected = node.properties.filter((p) => key(p) === name);
  if (selected.length !== 1) fail("config_shape", "property_missing_or_duplicate");
  return selected[0].value;
}
function literal(node, name, stage = "config_shape") {
  const value = property(node, name);
  if (value.type !== "Literal" || typeof value.value !== "string") fail(stage, "property_not_literal");
  return value.value;
}
function nativePage(html) {
  const { document } = parseHTML(html);
  if (
    document.querySelector("title")?.textContent.trim() !==
    "阿里巴巴集团招聘官网"
  )
    fail("portal_identity", "title_mismatch");
  for (const name of ["vendors", "alibaba-group"])
    if (
      [...document.querySelectorAll("script[src]")].filter(
        (n) =>
          n.getAttribute("src") ===
          `https://g.alicdn.com/platform/new-careers-portal/2.0.4/${name}.min.js`,
      ).length !== 1
    )
      fail("asset_identity", "asset_missing_or_duplicate");
  const config = new Map();
  for (const script of document.querySelectorAll("script:not([src])")) {
    const type = (script.getAttribute("type") || "").split(";")[0].trim().toLowerCase();
    // Data/import-map scripts are not executable JavaScript. They are not a
    // configuration source and must not be fed to the JavaScript AST parser.
    if (!["", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "module"].includes(type)) continue;
    let ast;
    try {
      ast = parse(script.textContent, {
        ecmaVersion: "latest",
        sourceType: type === "module" ? "module" : "script",
      });
    } catch {
      fail("inline_parse", "javascript_syntax_invalid");
    }
    for (const statement of ast.body) {
      const expression =
        statement.type === "ExpressionStatement" && statement.expression;
      if (
        expression?.type !== "AssignmentExpression" ||
        expression.left?.type !== "MemberExpression" ||
        expression.left.object?.name !== "window"
      )
        continue;
      const name = expression.left.computed
        ? expression.left.property?.value
        : expression.left.property?.name;
      if (!["__sysconfig", "__userconfig"].includes(name)) continue;
      if (
        expression.left.computed ||
        expression.operator !== "=" ||
        config.has(name)
      )
        fail("config_shape", "config_duplicate_or_dynamic");
      config.set(name, expression.right);
    }
  }
  const system = config.get("__sysconfig"),
    user = config.get("__userconfig"),
    circle = property(system, "circle");
  if (
    literal(system, "environment") !== "online" ||
    literal(user, "locale") !== "zh" ||
    literal(circle, "circleAliasName") !== "阿里巴巴集团" ||
    literal(circle, "portalOfficialChannel") !== "group_official_site" ||
    literal(circle, "portalDomain") !== "https://talent.alibaba.com"
  )
    fail("config_identity", "portal_config_mismatch");
  const nonce = literal(system, "__token__", "token_shape");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(nonce)) fail("token_shape", "token_invalid");
  return nonce;
}
export function buildAlibabaPublicSearchRequest(input) {
  if (
    !input ||
    Object.keys(input).some(
      (k) => !["siteId", "query", "page", "response"].includes(k),
    ) ||
    input.siteId !== "alibaba" ||
    typeof input.query !== "string" ||
    input.query.length > 99 ||
    /[\u0000-\u001f]/.test(input.query) ||
    !Number.isSafeInteger(input.page) ||
    input.page < 1 ||
    input.page > 20
  )
    fail("input", "invalid_input");
  const response = input.response;
  try {
  if (response?.status !== 200) fail("response_identity", "unexpected_status");
  if (response.url !== "https://talent.alibaba.com/") fail("response_identity", "unexpected_url");
  if (typeof response.text !== "string") fail("response_size", "invalid_body");
  if (response.text.length > 1048576) fail("response_size", "body_too_large");
  const nonce = nativePage(response.text),
    cookies = new Map();
  for (const item of String(response.headers?.["set-cookie"] || "").split(
    /,\s*(?=[A-Za-z_][A-Za-z0-9_-]*=)/,
  )) {
    const first = item.split(";")[0].trim(),
      eq = first.indexOf("="),
      name = first.slice(0, eq),
      value = first.slice(eq + 1);
    if (!["XSRF-TOKEN", "_rb_id", "SESSION"].includes(name)) continue;
    if (cookies.has(name) || !/^[A-Za-z0-9+/_=-]{1,512}$/.test(value)) fail("anonymous_cookie", "cookie_invalid_or_duplicate");
    cookies.set(name, value);
  }
  if (!cookies.has("XSRF-TOKEN") || !cookies.has("SESSION")) fail("anonymous_cookie", "cookie_missing");
  if (cookies.get("XSRF-TOKEN") !== nonce) fail("token_cookie_mismatch", "token_cookie_mismatch");
  return {
    url: ALIBABA_PUBLIC_LIST + "?_csrf=" + encodeURIComponent(nonce),
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      cookie: [...cookies]
        .map(([name, value]) => name + "=" + value)
        .join("; "),
    },
    body: JSON.stringify({
      batchId: "",
      corpCode: "",
      pageIndex: input.page,
      pageSize: 10,
      key: input.query,
      channel: "group_official_site",
      language: "zh_CN",
    }),
  };
  } catch (error) {
    const requestId = safeSourceDiagnosticRefs(response).requestId;
    if (error?.code === "native_transport_contract_mismatch" && requestId) error.requestId = requestId;
    throw error;
  }
}
