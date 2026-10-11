import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import fsAsync from "node:fs/promises";
import { randomUUID } from "node:crypto";

const marker = ".rjr-self-test";
export const desktopPages = Object.freeze([
  { page: "workbench", label: "工作台" },
  { page: "jobs", label: "岗位库" },
  { page: "applications", label: "投递进度" },
  { page: "profiles", label: "简历管理" },
  { page: "targets", label: "求职目标" },
  { page: "sources", label: "招聘来源" },
  { page: "logs", label: "运行日志" },
  { page: "trash", label: "回收站" },
  { page: "settings", label: "设置" },
]);
export const desktopWidths = Object.freeze([1440, 1024, 768, 375]);

export function desktopNavigationMatches(width, { links, toggle }) {
  return width <= 768 ? toggle && links === 0 : links === 9;
}

export async function withDesktopKeyboardFocus(debuggerApi, verify) {
  const attachedHere = !debuggerApi.isAttached();
  if (attachedHere) debuggerApi.attach("1.3");
  try {
    await debuggerApi.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    return await verify();
  } finally {
    try {
      await debuggerApi.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false });
    } finally {
      if (attachedHere) debuggerApi.detach();
    }
  }
}

export function validateDesktopMatrix(screenshots, dpr) {
  const issues = [], keys = new Set();
  for (const shot of screenshots.filter(shot => shot.matrix === true)) {
    const key = `${shot.page}:${shot.width}`;
    if (keys.has(key)) issues.push({ code: "duplicate_matrix_cell", key });
    keys.add(key);
    if (!desktopPages.some(item => item.page === shot.page) || !desktopWidths.includes(shot.width))
      issues.push({ code: "unknown_matrix_cell", key });
    if (!(shot.width === 375 ? [374,375,376] : [shot.width]).includes(shot.actualWidth))
      issues.push({ code: "actual_width_mismatch", key, actualWidth: shot.actualWidth });
    if (!Number.isFinite(shot.dpr) || Math.abs(shot.dpr - dpr) > 0.02)
      issues.push({ code: "dpr_mismatch", key, dpr: shot.dpr });
  }
  for (const { page } of desktopPages) for (const width of desktopWidths)
    if (!keys.has(`${page}:${width}`)) issues.push({ code: "missing_matrix_cell", key: `${page}:${width}` });
  return issues;
}

export function desktopContrastRatio(first, second) {
  const luminance = rgb => rgb.slice(0, 3).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126,0.7152,0.0722][index], 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
}

// Executed in Chromium. Colors come from computed styles, including alpha backgrounds;
// this function never injects a stylesheet or substitutes theme token values.
export function inspectDesktopUi(contrast) {
  const shown = el => el.getClientRects().length > 0 &&
    !el.closest('[data-closed],[inert],[aria-hidden=true]') &&
    getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).opacity !== '0';
  const label = el => (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().slice(0,80);
  const rectangle = el => {
    const r = el.getBoundingClientRect();
    return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const painter = canvas.getContext('2d', { willReadFrequently:true });
  const rgba = color => {
    painter.clearRect(0,0,1,1);
    painter.fillStyle = color;
    painter.fillRect(0,0,1,1);
    const pixel = painter.getImageData(0,0,1,1).data;
    return [pixel[0],pixel[1],pixel[2],pixel[3]/255];
  };
  const blend = (front, back) => front.slice(0,3).map((value,i) => value*front[3]+back[i]*(1-front[3]));
  const background = el => {
    if (!el) return [255,255,255];
    return blend(rgba(getComputedStyle(el).backgroundColor), background(el.parentElement));
  };
  const samples = [], tested = new Set();
  const text = (el, category='body') => {
    if (!shown(el) || el.closest(':disabled') || tested.has(el)) return;
    tested.add(el);
    const style = getComputedStyle(el), bg = background(el), fg = blend(rgba(style.color),bg);
    const large = parseFloat(style.fontSize)>=24 || (parseFloat(style.fontSize)>=18.666 && parseInt(style.fontWeight,10)>=700);
    const ratio = contrast(fg,bg), required = large ? 3 : 4.5;
    samples.push({ category, label:label(el), ratio, required, foreground:fg, background:bg, fontSize:style.fontSize, fontWeight:style.fontWeight, ok:ratio+0.001>=required });
  };
  const walker = document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) if (walker.currentNode.textContent.trim()) text(walker.currentNode.parentElement);
  for (const el of document.querySelectorAll('nav [aria-current=page]')) { tested.delete(el); text(el,'navigation'); }
  for (const el of document.querySelectorAll('main [role=alert],[data-slot=alert]')) { tested.delete(el); text(el,'warning'); }
  for (const el of document.querySelectorAll('input,textarea,[role=combobox]')) if (shown(el) && !el.disabled) { tested.delete(el); text(el,'field'); }
  const boundaries = [];
  for (const el of document.querySelectorAll('[data-slot=input],[data-slot=textarea],[data-slot=select-trigger],[data-slot=checkbox],[data-slot=radio-group-item],[data-slot=switch],[data-slot=button]')) {
    if (!shown(el) || el.disabled) continue;
    const style = getComputedStyle(el), outside = background(el.parentElement), fill = background(el);
    const fillRatio = contrast(fill,outside);
    const hasBorder = parseFloat(style.borderTopWidth)>0 && style.borderTopStyle!=='none' && rgba(style.borderTopColor)[3]>0;
    const borderRatio = hasBorder ? contrast(blend(rgba(style.borderTopColor),outside),outside) : 0;
    const field = ['input','textarea','select-trigger','checkbox','radio-group-item','switch'].includes(el.dataset.slot);
    if (field || hasBorder) boundaries.push({ label:label(el), fillRatio, borderRatio, required:3, ok:Math.max(fillRatio,borderRatio)+0.001>=3 });
    if (fillRatio>=3) { tested.delete(el); text(el,'primary'); }
  }
  const icons=[...document.querySelectorAll('[data-slot=button] svg,[data-slot=sidebar-trigger] svg,[data-slot=sheet-close] svg,[data-slot=dialog-close] svg')].filter(el=>shown(el)&&!el.closest(':disabled')).map(el=>{
    const bg=background(el),fg=blend(rgba(getComputedStyle(el).color),bg),ratio=contrast(fg,bg);
    return {label:label(el.closest('button,a')||el),ratio,required:3,ok:ratio+0.001>=3};
  });
  const hitTargets = [...document.querySelectorAll('[role=tab],[data-slot=button],[data-slot=sidebar-trigger],[data-slot=sidebar-menu-button],[data-slot=select-trigger],[data-slot=sheet-close],[data-slot=dialog-close]')]
    .filter(shown).map(el => ({ label:label(el), ...rectangle(el), ok:el.getBoundingClientRect().width>=43.5 && el.getBoundingClientRect().height>=43.5 }));
  const tables = [...document.querySelectorAll('table')].filter(shown).map(el => {
    let container = el.parentElement;
    while (container && !['auto','scroll'].includes(getComputedStyle(container).overflowX)) container=container.parentElement;
    return { label:label(el), tableWidth:el.scrollWidth, containerWidth:container?.clientWidth, contained:Boolean(container && container!==document.body && container!==document.documentElement && container.getBoundingClientRect().right<=innerWidth+1) };
  });
  const popups = [...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=listbox],[role=menu]')].filter(shown).map(el => {
    const r=rectangle(el);
    return { label:label(el), ...r, ok:r.left>=-1 && r.right<=innerWidth+1 && r.top>=-1 && r.bottom<=innerHeight+1 };
  });
  const active = document.activeElement;
  const focusState = { documentFocused:document.hasFocus(), active:active ? {
    tag:active.tagName, label:label(active), slot:active.getAttribute('data-slot'),
    visible:shown(active), focusVisible:active.matches(':focus-visible'),
    focusGuard:active.hasAttribute('data-base-ui-focus-guard'), ...rectangle(active),
  } : null };
  let focus;
  if (active && shown(active) && active.matches(':focus-visible')) {
    const style = getComputedStyle(active), outside=background(active.parentElement);
    const ratio = contrast(blend(rgba(style.outlineColor),outside),outside);
    focus={ label:label(active), ratio, outlineWidth:style.outlineWidth, outlineStyle:style.outlineStyle, ok:parseFloat(style.outlineWidth)>0 && style.outlineStyle!=='none' && ratio+0.001>=3 };
  }
  return { actualWidth:innerWidth, dpr:devicePixelRatio, scrollWidth:document.documentElement.scrollWidth,
    overflow:document.documentElement.scrollWidth>innerWidth+1, samples, boundaries, icons, hitTargets, tables, popups, focus, focusState,
    reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches };
}
function checkParents(directory) {
  for (let cursor = path.resolve(directory); ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
      throw Error("unsafe_self_test_directory");
    if (path.dirname(cursor) === cursor) break;
  }
}
export function prepareSelfTestEnvironment({
  explicitDataDir,
  tempRoot = os.tmpdir(),
} = {}) {
  const root = path.resolve(tempRoot);
  checkParents(root);
  fs.mkdirSync(root, { recursive: true });
  let dataDir;
  if (explicitDataDir) {
    if (!path.isAbsolute(explicitDataDir))
      throw Error("unsafe_self_test_directory");
    dataDir = path.resolve(explicitDataDir);
    checkParents(dataDir);
    if (
      !/^rjr-self-test-[\w-]+$/.test(path.basename(dataDir)) ||
      dataDir === root
    )
      throw Error("unsafe_self_test_directory");
    if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length)
      throw Error("nonempty_self_test_directory");
    fs.mkdirSync(dataDir, { recursive: true });
  } else dataDir = fs.mkdtempSync(path.join(root, "rjr-self-test-"));
  fs.writeFileSync(
    path.join(dataDir, marker),
    "isolated synthetic self-test\n",
    { flag: "wx" },
  );
  let now = Date.parse("2026-10-09T00:00:00Z");
  const clock = {
    now: () => now,
    advance: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) throw Error("invalid_clock_advance");
      now += ms;
    },
  };
  const controls = { hold: false, failCleanup: false, failCleanupRunIds: new Set() };
  const record = {
    sourceId: "synthetic-desktop",
    siteId: "synthetic-desktop-1",
    sourceRecordId: "offline-1",
    sourceRecordIdKind: "authority",
    urlKind: "job_detail",
    identityScope: "synthetic-desktop-1",
    kind: "job",
    title: "消防工程师与机场应急保障岗位合成长中文名称用于换行检查",
    company: "合成机场集团",
    cities: ["合成市"],
    jobType: "campus",
    graduationYear: 2027,
    degree: "本科",
    url: "https://jobs.example.invalid/offline-1",
    description:
      "合成公开岗位：消防工程专业，本科，2027届。负责机场消防、应急管理与安全检查。",
    requiredCertificates: [],
    publishedAt: new Date(now).toISOString(),
    parserVersion: "synthetic-desktop-1",
    evidence: [],
  };
  const provider = {
    id: "synthetic-desktop",
    name: "合成离线来源",
    capabilities: { category: "job_board", jobTypes: ["campus"], detail: true },
    configSchema: { enabled: "boolean" },
    async collect(ctx) {
      if (controls.hold && ctx.queries?.some((q) => q.keyword))
        await new Promise((resolve) =>
          ctx.signal.addEventListener("abort", resolve, { once: true }),
        );
      ctx.signal?.throwIfAborted();
      await ctx.onBatch?.([structuredClone(record)]);
      return {
        records: [structuredClone(record)],
        issues: [],
        coverage: [
          {
            sourceId: this.id,
            siteId: "synthetic-desktop-1",
            status: "complete",
            queries: ["消防"],
            cities: ["合成市"],
            pages: 1,
          },
        ],
        stats: { raw: 1, parsed: 1, accepted: 1 },
      };
    },
    async fetchDetail(job) {
      return job;
    },
    async probe() {
      return { status: "ready" };
    },
  };
  const cfg = {
    deepseek: {
      apiKey: "",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      concurrency: 1,
      timeoutMs: 10000,
      allowUserKey: true,
    },
    search: {
      provider: "none",
      tavilyApiKey: "",
      serperApiKey: "",
      bochaApiKey: "",
    },
    sources: {
      zhaopin: { enabled: false, maxPages: 0 },
      shixiseng: { enabled: false, maxPages: 0 },
      "synthetic-desktop": { enabled: true },
      coverageMode: "standard",
      v2Budgets: {
        maxSites: 1,
        maxRequests: 10,
        maxKeywords: 2,
        maxPagesPerQuery: 1,
        maxDetails: 2,
      },
    },
    match: { shortlistSize: 10, enrichTopN: 0, scoreBatchSize: 5, minScore: 0 },
    filters: {
      graduationYear: "2027",
      includeInternship: false,
      strict: true,
      yearQueryCount: 1,
      cities: [],
    },
    profile: {},
    auth: {
      mode: "none",
      passwordHash: "",
      sessionTtlHours: 1,
      maxLoginFails: 5,
      lockMinutes: 1,
    },
    limits: {
      maxConcurrent: 2,
      maxQueue: 4,
      dailyGlobal: 100,
      dailyPerIp: 100,
      perIpCooldownMs: 0,
    },
    server: { host: "127.0.0.1", port: 0, trustProxy: false, publicUrl: "" },
    network: { dnsMode: "system" },
    __searchKeys: {},
    __activeSearchProvider: "",
    __deepseekKeySource: "synthetic",
  };
  const dependencies = {
    clock,
    startScheduler: false,
    fsAdapter: {
      ...fsAsync,
      async unlink(filename) {
        if (
          controls.failCleanup &&
          /[\\/]runs-v2[\\/]/.test(filename) &&
          controls.failCleanupRunIds.has(path.basename(filename, ".json"))
        )
          throw Object.assign(Error("synthetic_cleanup_failure"), {
            code: "EIO",
          });
        return fsAsync.unlink(filename);
      },
    },
    registry: {
      get: (id) => (id === provider.id ? provider : undefined),
      list: () => [provider],
    },
    catalog: [
      {
        siteId: "synthetic-desktop-1",
        providerId: provider.id,
        category: "job_board",
        name: "合成离线来源",
        origin: "https://jobs.example.invalid",
        status: "ready",
        verifiedAt: new Date(now).toISOString(),
        probeEvidence: [{ hasRequirements: true }],
      },
    ],
    requestFactory: () => async () => {
      throw Error("offline_network_forbidden");
    },
    modelFactory: () => ({
      synthetic: true,
      available: true,
      async chatJson() {
        return [];
      },
    }),
  };
  return {
    dataDir,
    cfg,
    dependencies,
    clock,
    controls,
    cleanup() {
      checkParents(dataDir);
      if (!fs.existsSync(dataDir)) return;
      if (!fs.existsSync(path.join(dataDir, marker)))
        throw Error("unsafe_self_test_directory");
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function makeSelfTestPdf(lines) {
  const escape = (s) =>
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  const content = `BT /F1 14 Tf 40 760 Td 20 TL\n${lines.map((l) => `(${escape(l)}) Tj T*`).join("\n")}\nET`,
    objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("");
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

export async function runWorkspaceSelfTest({
  window,
  context,
  clock,
  controls,
  dataDir,
  networkGuard,
  rendererErrors = [],
  externalIntents = [],
}) {
  const results = [],
    screenshots = [],
    interactions = [],
    visualAudits = [],
    origin = new URL(window.webContents.getURL()).origin;
  const js = (source) => window.webContents.executeJavaScript(source, true);
  let requestedWidth = await js("innerWidth"), lastPage = "workbench";
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const observe = (name, ok, details) => results.push({ name, ok:Boolean(ok), ...(details ? {details} : {}) });
  const check = (name, ok, details) => {
    observe(name,ok,details);
    if (!ok) throw Error(name);
  };
  const trace = async (action,label,details={}) => interactions.push({ action,label,page:lastPage,
    ...(await js("({actualWidth:innerWidth,dpr:devicePixelRatio})")),...details });
  const capture = async (file,extra={}) => {
    const geometry=await js("({actualWidth:innerWidth,dpr:devicePixelRatio,label:document.querySelector('h1')?.textContent.trim()})");
    const page=desktopPages.find(item=>item.label===geometry.label)?.page || lastPage;
    fs.writeFileSync(path.join(dataDir,file),(await window.webContents.capturePage()).toPNG());
    screenshots.push({page,width:requestedWidth,actualWidth:geometry.actualWidth,dpr:geometry.dpr,file,...extra});
  };
  const audit = async (label) => {
    const value=await js(`(${inspectDesktopUi.toString()})(${desktopContrastRatio.toString()})`);
    visualAudits.push({page:lastPage,width:requestedWidth,label,...value});
    observe(label+"：页面无横向溢出",!value.overflow,{actualWidth:value.actualWidth,scrollWidth:value.scrollWidth});
    observe(label+"：文字对比度符合 4.5/3",value.samples.length>0 && value.samples.every(sample=>sample.ok),{sampleCount:value.samples.length,failures:value.samples.filter(sample=>!sample.ok)});
    observe(label+"：必要控件边界对比度至少 3",value.boundaries.every(sample=>sample.ok),{sampleCount:value.boundaries.length,failures:value.boundaries.filter(sample=>!sample.ok)});
    observe(label+"：主要按钮图标对比度至少 3",value.icons.every(sample=>sample.ok),{sampleCount:value.icons.length,failures:value.icons.filter(sample=>!sample.ok)});
    observe(label+"：Tabs 与主要图标按钮命中至少 44px",value.hitTargets.every(target=>target.ok),{sampleCount:value.hitTargets.length,failures:value.hitTargets.filter(target=>!target.ok)});
    observe(label+"：表格只在本地容器横滚",value.tables.every(table=>table.contained),value.tables);
    observe(label+"：浮层位于视口内",value.popups.every(popup=>popup.ok),value.popups);
    if(value.focus) observe(label+"：焦点边界对比度至少 3",value.focus.ok,value.focus);
    return value;
  };
  const wait = async (source, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await js(source)) return true;
      await delay(30);
    }
    throw Error("renderer_wait_timeout: " + source.slice(0, 180));
  };
  const visible = `el=>el.getClientRects().length>0&&!el.disabled&&!el.closest('[data-closed],[inert],[aria-hidden=true]')`;
  const locate = (
    name,
    selector = 'button,[role="button"],a,[role="menuitem"],[role="option"]',
    card,
  ) =>
    `(()=>{const name=${JSON.stringify(name)}, root=${card ? `[...document.querySelectorAll('[data-slot="card"]')].find(el=>[...el.querySelectorAll('[data-slot="card-title"]')].some(t=>t.textContent.trim()===${JSON.stringify(card)}))` : "document"};return root&&[...root.querySelectorAll(${JSON.stringify(selector)})].find(el=>(${visible})(el)&&(el.getAttribute('aria-label')===name||(()=>{const copy=el.cloneNode(true);copy.querySelectorAll('[aria-hidden=true]').forEach(node=>node.remove());return copy.textContent.trim()===name;})()));})()`;
  const click = async (name, options = {}) => {
    const find = locate(name, options.selector, options.card);
    await wait(`Boolean(${find})`);
    await js(
      `(()=>{const el=${find};el.scrollIntoView({block:'center'});el.focus();el.click();})()`,
    );
    await delay(80);
    await trace("click",name);
  };
  const input = async (label, value) => {
    await wait(
      `Boolean(document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']')||[...document.querySelectorAll('label')].find(el=>el.getClientRects().length>0&&!el.closest('[data-closed],[inert],[aria-hidden=true]')&&el.textContent.trim()===${JSON.stringify(label)}))`,
    );
    await js(
      `(()=>{const label=${JSON.stringify(label)}, node=document.querySelector('[aria-label='+CSS.escape(label)+']')||[...document.querySelectorAll('input,textarea')].find(node=>node.getClientRects().length>0&&!node.closest('[data-closed],[inert],[aria-hidden=true]')&&node.id===[...document.querySelectorAll('label')].find(el=>el.getClientRects().length>0&&!el.closest('[data-closed],[inert],[aria-hidden=true]')&&el.textContent.trim()===label)?.htmlFor);if(!node)throw Error('missing field '+label);node.focus();const prototype=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await delay(60);
    await trace("input",label,{length:String(value).length});
  };
  const escaped = async () => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await delay(100);
    await trace("key","Escape");
  };
  const navigate = async (label) => {
    if (!(await js(`Boolean(${locate(label,"nav a")})`))) {
      await click("切换导航");
      await wait(`Boolean(${locate(label,"nav a")})`);
    }
    await click(label, { selector: "nav a" });
    await wait(
      `document.querySelector('h1')?.textContent.trim()===${JSON.stringify(label)}`,
    );
    lastPage=desktopPages.find(item=>item.label===label).page;
    await wait("!document.querySelector('main [data-slot=skeleton]')");
    await trace("navigate",label);
  };
  const resizeViewport = async (width, height = 900) => {
    requestedWidth=width;
    let requested = width;
    const attempts = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      window.setContentSize(requested, height);
      await delay(250);
      const actual = await js("innerWidth");
      attempts.push({ requested, actual });
      if (actual === width)
        return {
          requestedWidth: width,
          nativeRequestedWidth: requested,
          attempts,
        };
      requested += Math.sign(width - actual);
    }
    // Fractional Windows DPI can quantize the odd 375px viewport to 374/376.
    // Preserve the actual width and test its navigation breakpoint honestly.
    const quantized = width===375 && (attempts.find(item=>item.actual===374)||attempts.find(item=>item.actual===376));
    if (quantized) {
      window.setContentSize(quantized.requested, height);
      await delay(250);
      if ((await js("innerWidth")) === quantized.actual)
        return {
          requestedWidth: width,
          nativeRequestedWidth: quantized.requested,
          rounded: true,
          attempts,
        };
    }
    throw Error(
      "self_test_viewport_width_mismatch: " +
        JSON.stringify({ width, dpr: await js("devicePixelRatio"), attempts }),
    );
  };
  const api = async (route, body, method) => {
    const response = await fetch(origin + "/api/v2" + route, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok)
      throw Error(
        "self_test_api " +
          route +
          " " +
          response.status +
          " " +
          (data.code || data.message || ""),
      );
    return data;
  };
  const phase = async (name, fn) => {
    console.log("[self-test] " + name);
    window.__selfTestPhase = name;
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({
        name,
        ok: false,
        error: String(error.message).slice(0, 500),
      });
      try {
        await capture("failure.png",{scenario:name});
      } catch {}
      throw error;
    }
  };
  const textHas = (value) =>
    `document.body.textContent.includes(${JSON.stringify(value)})`;
  const countRecords = (workspace, pkg, key) =>
    Object.values(workspace[key] || {})
      .flat()
      .filter((r) => r.ownerPackageId === pkg).length;
  let a, b, profile, bossContracts;
  try {
    await wait("Boolean(document.querySelector('nav'))");
    await phase("九页真实导航与严格 CSP", async () => {
      for (const label of [
        "工作台",
        "岗位库",
        "投递进度",
        "简历管理",
        "求职目标",
        "招聘来源",
        "运行日志",
        "回收站",
        "设置",
      ])
        await navigate(label);
      check(
        "Base UI 未注入 style 元素",
        await js("document.querySelectorAll('style').length===0"),
      );
    });
    await phase("表单错误、焦点和简历导入校正保存", async () => {
      await navigate("简历管理");
      await click("导入简历");
      await click("提取并预览");
      await wait("Boolean(document.querySelector('[role=alert]'))");
      check(
        "错误 summary 接收焦点",
        await js("document.activeElement?.getAttribute('role')==='alert'"),
      );
      await capture("profile-field-error.png",{scenario:"字段失败"});
      await input(
        "粘贴简历正文",
        "合成简历，姓名合成人员，2027届本科消防工程专业。掌握机场消防、应急管理和安全检查，具有合成课程项目经历。",
      );
      await click("提取并预览");
      await wait("Boolean(document.getElementById('profile.major'))");
      await input("专业", "消防工程");
      await input("毕业年份", "2027");
      await click("下一步");
      await input("版本名称", "合成简历版本");
      await click("保存简历");
      await wait(textHas("简历已保存："));
      profile = (await api("/profiles")).profiles[0];
      check("校正专业实际保存", profile?.profile?.major === "消防工程");
    });
    const createTarget = async (name) => {
      await navigate("求职目标");
      await click("新建目标");
      await click("下一步");
      await input("求职方向", "消防、机场");
      await click("下一步");
      await click("下一步");
      await input("版本名称", name);
      await click("保存目标");
      await wait(textHas("目标已保存：" + name));
      return (await api("/targets")).targets.find(
        (t) => t.versionName === name,
      );
    };
    await phase("命名目标、独立副本、停用启用与重命名", async () => {
      a = await createTarget("合成目标A");
      check(
        "目标完整独立简历副本",
        a.profileSnapshot?.text?.length > 30 &&
          a.profileSnapshot?.revisionId !== profile.revisionId,
      );
      await click("版本操作", { card: "合成目标A" });
      await click("停用");
      await wait(textHas("版本已停用"));
      check(
        "停用已持久化",
        (await api("/targets")).targets.find((t) => t.packageId === a.packageId)
          .enabled === false,
      );
      await click("版本操作", { card: "合成目标A" });
      await click("启用");
      await wait(textHas("版本已启用"));
      await click("版本操作", { card: "合成目标A" });
      await click("重命名");
      await input("版本名称", "合成目标A已命名");
      await click("保存名称");
      await wait(textHas("版本名称已保存"));
      a = (await api("/targets")).targets.find(
        (t) => t.packageId === a.packageId,
      );
      check("重命名持久化", a.versionName === "合成目标A已命名");
      b = await createTarget("合成目标B");
      await click("设为当前目标", { card: a.versionName });
    });
    await phase("真实更新、规则评价、岗位事实与投递记录", async () => {
      await navigate("工作台");
      await click("更新岗位");
      await wait(textHas("岗位更新完成"));
      const w = await context.repository.read();
      check(
        "当前版本采集已保存",
        countRecords(w, a.packageId, "jobs") === 1 &&
          Object.values(w.runs).filter(
            (r) =>
              r.ownerPackageId === a.packageId &&
              r.collectionRole !== "collection_root",
          ).length === 1,
      );
      await navigate("岗位库");
      await click("查看岗位");
      await wait(textHas("本版本事实、评价与投递记录"));
      await wait("Boolean(document.querySelector('[aria-label=岗位证据摘要]'))");
      check(
        "真实岗位证据显示未知时效与未核验投递",
        (await js(textHas("招聘时效待核验"))) &&
          (await js(textHas("投递入口待核验"))),
      );
      await delay(200);
      await capture("job-evidence.png",{scenario:"证据摘要"});
      await click("评价依据",{selector:"[role=tab]"});
      await wait(textHas("当前评价依据"));
      check(
        "真实规则评价显示资格核对与评分组成",
        (await js(textHas("资格核对"))) && (await js(textHas("评分组成"))),
      );
      await delay(250);
      check(
        "Sheet 焦点位于弹层",
        await js("Boolean(document.activeElement?.closest('[role=dialog]'))"),
        await js(
          "({active:document.activeElement?.outerHTML.slice(0,250),focus:document.hasFocus(),dialogs:[...document.querySelectorAll('[role=dialog]')].map(e=>({closed:e.hasAttribute('data-closed'),title:e.textContent.slice(0,80)}))})",
        ),
      );
      await click("规则重新评价");
      await wait(textHas("岗位已按规则重新评价"));
      await click("记录投递");
      await input("投递备注", "合成投递备注，仅属于目标A");
      await click("保存投递记录");
      await wait("!document.querySelector('form [id=\"application-note\"]')");
      await escaped();
      await navigate("投递进度");
      await wait(textHas("合成机场集团"));
      check(
        "投递实际提交",
        countRecords(
          await context.repository.read(),
          a.packageId,
          "applications",
        ) === 1,
      );
    });
    await phase("取消任务与切换版本竞态隔离", async () => {
      clock.advance(1000);
      controls.hold = true;
      const originalStart = context.runService.startRun;
      let releaseStart;
      context.runService.startRun = async (...args) => {
        await new Promise((resolve) => (releaseStart = resolve));
        return originalStart(...args);
      };
      try {
        await navigate("工作台");
        await click("更新岗位");
        for (let attempt = 0; !releaseStart && attempt < 100; attempt++)
          await delay(20);
        if (!releaseStart) throw Error("self_test_start_not_entered");
        await navigate("岗位库");
        await navigate("工作台");
        check(
          "未提交启动跨页返回时禁止重复提交",
          await js(
            "[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='更新岗位')?.disabled === true",
          ),
        );
        releaseStart();
        // Root activities expose their own controls; the child cancel button is
        // intentionally hidden. Pause is enabled only while this root collects.
        await wait(`Boolean(${locate("暂停采集", '[aria-label="当前采集活动"] button')})`);
        check("延迟提交的后台任务已在原版本恢复", true);
      } finally {
        context.runService.startRun = originalStart;
        releaseStart?.();
      }
      const heldRunCount = countRecords(
        await context.repository.read(),
        a.packageId,
        "runs",
      );
      await navigate("岗位库");
      await navigate("工作台");
      await wait(`Boolean(${locate("暂停采集", '[aria-label="当前采集活动"] button')})`);
      check(
        "导航回来恢复活跃任务并禁用重复启动",
        (await js(
          "[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='更新岗位')?.disabled === true",
        )) &&
          countRecords(await context.repository.read(), a.packageId, "runs") ===
            heldRunCount,
      );
      await wait(textHas("持续采集活动"));
      const beforePause = Object.values(
        (await context.repository.read()).runs,
      ).find(
        (r) =>
          r.ownerPackageId === a.packageId &&
          r.collectionProgress?.status === "collecting",
      );
      if (!beforePause) throw Error("self_test_active_collection_missing");
      const activityRef = {
          scope: { packageId: a.packageId, targetRevisionId: a.revisionId },
          activityId: beforePause.runId,
        },
        beforeUsage = (await context.collectionService.get(activityRef))
          .collectionUsage;
      await click("暂停采集");
      await wait(textHas("活动已暂停"));
      check(
        "真实活动暂停持久化",
        (await context.repository.read()).runs[beforePause.runId]
          .collectionProgress.status === "paused",
      );
      await capture("collection-paused.png",{scenario:"暂停采集"});
      await click("继续采集");
      await wait(textHas("已继续采集，沿用活动累计额度"));
      const priorCancellationCleared =
        "!Array.from(document.querySelectorAll('p[role=status]')).some(p=>p.textContent.trim()==='任务已取消')";
      await wait(priorCancellationCleared);
      check(
        "真实活动续采不显示上一轮取消结论",
        await js(priorCancellationCleared),
      );
      const resumed = await context.collectionService.get(activityRef);
      check(
        "真实活动续采沿用根编号与累计额度",
        resumed.collectionProgress.status === "collecting" &&
          resumed.collectionUsage.costUpperBoundCny >=
            beforeUsage.costUpperBoundCny &&
          resumed.collectionProgress.limits.maxCostCny ===
            beforePause.collectionProgress.limits.maxCostCny,
      );
      await capture("collection-controls.png",{scenario:"恢复续采"});
      await click("取消活动");
      await wait(textHas("活动已取消"));
      controls.hold = false;
      await navigate("求职目标");
      await click("设为当前目标", { card: b.versionName });
      await navigate("岗位库");
      await wait(textHas("这里还没有岗位"));
      check(
        "目标B岗位没有混入目标A",
        countRecords(await context.repository.read(), b.packageId, "jobs") ===
          0,
      );
      await navigate("求职目标");
      await click("设为当前目标", { card: a.versionName });
      await context.repository.mutateWorkspace((w) => {
        const original = Object.values(w.jobs).find(
            (j) => j.ownerPackageId === a.packageId,
          ),
          clone = structuredClone(original);
        clone.jobId = original.jobId + "-synthetic-duplicate";
        clone.recordId = randomUUID();
        w.jobs[clone.jobId] = clone;
        const observation = structuredClone(
          Object.values(w.observations).find((o) => o.jobId === original.jobId),
        );
        observation.jobId = clone.jobId;
        observation.recordId = randomUUID();
        observation.observationId += "-synthetic-duplicate";
        w.observations[observation.observationId] = observation;
        w.targetMembers[a.revisionId][clone.jobId] = {
          ...structuredClone(w.targetMembers[a.revisionId][original.jobId]),
          factRefs: [{ observationId: observation.observationId }],
          currentObservationId: observation.observationId,
        };
      });
      await navigate("岗位库");
      await click("预览所有版本去重");
      await wait(textHas("逐版本清理重复岗位"));
      await click("确认清理所选重复岗位");
      await wait(textHas("所选版本内重复岗位已清理"));
      check(
        "真实去重保留当前版本人工投递与其他版本",
        countRecords(await context.repository.read(), a.packageId, "jobs") ===
          1 &&
          countRecords(
            await context.repository.read(),
            a.packageId,
            "applications",
          ) === 1 &&
          Boolean((await context.repository.read()).packages[b.packageId]),
      );
      await click("关闭预览");
      for (const width of [375, 768, 1024, 1440]) {
        const sizing = await resizeViewport(width);
        const geometry = {
          ...sizing,
          ...(await js(
            "({width:innerWidth,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth+1})",
          )),
        };
        check(
          "岗位库请求" +
            width +
            "px / 实际" +
            geometry.width +
            "px 无页面横向溢出",
          !geometry.overflow,
          geometry,
        );
        const file =
          "jobs-" +
          width +
          "-" +
          String(geometry.dpr).replace(".", "_") +
          ".png";
        await capture(file,{scenario:"岗位库宽度",sizing});
        if (width === 375) {
          await click("当前目标", { selector: "[role=combobox]" });
          await wait("Boolean(document.querySelector('[role=listbox]'))");
          const popup = await js(
            "(()=>{const r=document.querySelector('[role=listbox]').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};})()",
          );
          check(
            "375px 目标选择浮层定位在窗口内",
            popup.left >= -1 && popup.right <= popup.width + 1,
            popup,
          );
          await escaped();
          await wait("!document.querySelector('[role=listbox]')");
          check(
            "目标选择 Esc 关闭并归还焦点",
            await js(
              "document.activeElement.getAttribute('aria-label')==='当前目标'",
            ),
          );
        }
      }
      await resizeViewport(1440);
      await navigate("工作台");
      await click("当前目标", { selector: "[role=combobox]" });
      await click("全部目标 · 只读汇总", { selector: "[role=option]" });
      await wait("location.hash.includes('allTargets=true')");
      check(
        "全部目标汇总禁止发起更新",
        await js(
          "![...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='更新岗位'&&!el.disabled)",
        ),
      );
      await click("当前目标", { selector: "[role=combobox]" });
      await click(a.versionName, { selector: "[role=option]" });
      await wait(
        "location.hash.includes('packageId=' + " +
          JSON.stringify(a.packageId) +
          ")",
      );
    });
    await phase("来源检查、日志与生产安全桥接", async () => {
      clock.advance(1000);
      controls.hold = true;
      await navigate("工作台");
      await click("更新岗位");
      await wait(`Boolean(${locate("暂停采集", '[aria-label="当前采集活动"] button')})`);
      try {
        await navigate("招聘来源");
        await input("搜索来源","没有匹配的合成来源");
        await wait(textHas("暂无匹配的招聘来源"));
        check("来源搜索真实显示空结果",await js("!document.querySelector('[aria-label=\"合成离线来源来源摘要\"]')"));
        await capture("source-search-empty.png",{scenario:"来源搜索"});
        await input("搜索来源","合成离线来源");
        await wait(`Boolean(${locate("查看来源配置")})`);
        await click("查看来源配置");
        await wait(textHas("合成离线来源来源配置"));
        await input("搜索此来源站点","合成离线来源");
        await capture("source-detail.png",{scenario:"来源详情"});
        await click("检查合成离线来源");
        await wait(textHas("来源检查已完成"));
        await escaped();
      } finally {
        await navigate("工作台");
        await click("取消活动");
        await wait(textHas("活动已取消"));
        controls.hold = false;
      }
      await navigate("运行日志");
      check("日志页显示当前版本范围", await js(textHas(a.versionName)));
      await click("系统诊断");
      await wait(
        "document.querySelector('main').textContent.includes('显示 ')",
      );
      check(
        "实际系统诊断按当前版本成功读取",
        await js("!document.querySelector('[role=alert]')"),
      );
      await navigate("设置");
      const keys = await js("Object.keys(window.desktopBridge).sort()");
      check(
        "仅开放生产桥接方法",
        JSON.stringify(keys) ===
          JSON.stringify(
            [
              "clearCollectionSession",
              "copyDataLocation",
              "deleteKey",
              "getDataLocations",
              "getCollectionCapabilities",
              "getCollectionSessionStatus",
              "getKeyStatus",
              "isAvailable",
              "openDataLocation",
              "openCollectionLogin",
              "probeBossSession",
              "reportDiagnostic",
              "saveKey",
              "verifyCollectionSession",
            ].sort(),
          ),
      );
      const status = await js(
        "window.desktopBridge.saveKey('deepseek','synthetic-self-test-key').then(()=>window.desktopBridge.getKeyStatus('deepseek'))",
      );
      check("合成 Key 加密保存及状态", status.configured === true);
      check(
        "密钥没有明文落盘",
        !fs
          .readFileSync(path.join(dataDir, "credentials.v2.json"), "utf8")
          .includes("synthetic-self-test-key"),
      );
      await js("window.desktopBridge.deleteKey('deepseek')");
      check(
        "合成 Key 已删除",
        !(await js("window.desktopBridge.getKeyStatus('deepseek')")).configured,
      );
      const locations = await js("window.desktopBridge.getDataLocations()");
      check(
        "安全目录仅返回合成根",
        Object.values(locations.locations || locations)
          .filter((v) => typeof v === "string")
          .every((v) => path.resolve(v).startsWith(path.resolve(dataDir))),
      );
      await js("window.desktopBridge.openDataLocation('logs')");
      check(
        "打开目录被记录为意图",
        externalIntents.some((i) => i.kind === "directory-open"),
      );
      check(
        "桥接拒绝任意目录",
        await js(
          "window.desktopBridge.openDataLocation('../outside').then(()=>false,()=>true)",
        ),
      );
    });
    await phase("真实窗口后退与完整刷新恢复版本和筛选", async () => {
      await navigate("岗位库");
      await input("搜索岗位", "消防");
      await wait(
        "new URLSearchParams(location.hash.split('?')[1]).get('search')==='消防'",
      );
      await navigate("投递进度");
      window.webContents.goBack();
      await wait(
        "document.querySelector('h1')?.textContent==='岗位库'&&document.getElementById('job-search')?.value==='消防'",
      );
      check(
        "真实后退恢复岗位筛选",
        await js(
          "new URLSearchParams(location.hash.split('?')[1]).get('packageId')===" +
            JSON.stringify(a.packageId),
        ),
      );
      window.webContents.reload();
      await wait(
        "document.querySelector('h1')?.textContent==='岗位库'&&document.getElementById('job-search')?.value==='消防'",
      );
      await wait(
        "document.querySelector('[aria-label=当前目标]')?.textContent.includes(" +
          JSON.stringify(a.versionName) +
          ")",
      );
      check(
        "真实刷新恢复准确版本和筛选",
        await js(
          "new URLSearchParams(location.hash.split('?')[1]).get('targetRevisionId')===" +
            JSON.stringify(a.revisionId),
        ),
      );
      await js(
        "window.__rjrSelfTestIssues=[];window.addEventListener('securitypolicyviolation',e=>window.__rjrSelfTestIssues.push({code:'csp_violation',directive:e.violatedDirective}));window.addEventListener('error',()=>window.__rjrSelfTestIssues.push({code:'renderer_error'}));window.addEventListener('unhandledrejection',()=>window.__rjrSelfTestIssues.push({code:'renderer_rejection'}));",
      );
    });
    await phase("正常合成版本九页四宽度矩阵与 computedStyle 验收",async()=>{
      const before=await context.repository.read();
      check("矩阵开始前正常目标与源简历仍存在",[a,b,profile].every(item=>before.packages[item.packageId]?.state==='active'));
      for(const width of desktopWidths) {
        const sizing=await resizeViewport(width);
        for(const {page,label} of desktopPages) {
          await navigate(label);
          if(page==='sources') await wait(`Boolean(${locate("查看来源配置")})`);
          if(page==='settings') await wait("Boolean(document.getElementById('model.model'))");
          if(page==='jobs') await wait(`Boolean(${locate("查看岗位")})`);
          await js("scrollTo(0,0);document.querySelector('main')?.scrollTo(0,0)");
          await delay(80);
          const geometry=await audit(label+" / "+width+"px");
          const nav=await js(`({links:[...document.querySelectorAll('nav a')].filter(${visible}).length,toggle:Boolean(${locate("切换导航")})})`);
          observe(label+"：实际视口导航断点",desktopNavigationMatches(geometry.actualWidth,nav),{...nav,actualWidth:geometry.actualWidth});
          await capture(`matrix-${page}-${width}-${String(geometry.dpr).replace('.','_')}.png`,{matrix:true,sizing});
        }
      }
      check("九页四宽度矩阵完整且真实",validateDesktopMatrix(screenshots,await js("devicePixelRatio")).length===0,validateDesktopMatrix(screenshots,await js("devicePixelRatio")));
      const after=await context.repository.read();
      check("矩阵结束仍保留正常版本和投递子集",[a,b,profile].every(item=>after.packages[item.packageId]?.state==='active') && countRecords(after,a.packageId,'applications')===1);
      await resizeViewport(1440);
    });
    await phase("高分仍显示证据不足与窄屏详情焦点",async()=>{
      const workspace=await context.repository.read();
      const current=(await api('/jobs?'+new URLSearchParams({packageId:a.packageId,targetRevisionId:a.revisionId}))).items[0]?.evaluation;
      const original=current && workspace.evaluations[current.evaluationId];
      if(!original) throw Error("synthetic_evaluation_missing");
      const saved=structuredClone(original);
      const syntheticId=randomUUID();
      try {
        await context.repository.mutateWorkspace(w=>{w.evaluations[syntheticId]={...saved,evaluationId:syntheticId,recordId:randomUUID(),score:100,createdAt:new Date(clock.now()+60000).toISOString()};});
        await resizeViewport(375);
        await navigate("岗位库");
        await js(`window.__rjrReturnFocus=${locate("查看岗位")}`);
        await click("查看岗位");
        await wait(textHas("辅助评分：100 分"));
        check("高分不隐藏待核验时效与投递入口",(await js(textHas("招聘时效待核验"))) && (await js(textHas("投递入口待核验"))) && !(await js(`Boolean(${locate("前往投递")})`)));
        await audit("375px 高分低证据详情");
        await capture("job-high-score-low-evidence.png",{scenario:"高分低证据"});
        const scrollEnd=await js(`(()=>{
          const dialog=[...document.querySelectorAll('[role=dialog]')].find(el=>(${visible})(el));
          const shown=${visible};
          const scrollable=[dialog,...dialog.querySelectorAll('*')].filter(el=>['auto','scroll'].includes(getComputedStyle(el).overflowY));
          scrollable.forEach(el=>el.scrollTop=el.scrollHeight);
          const last=[...dialog.querySelectorAll('p,dd')].filter(shown).at(-1);
          const focus=[...dialog.querySelectorAll('button,a[href],[tabindex="0"]')].filter(el=>shown(el)&&!el.matches('[data-slot=sheet-close],[data-slot=dialog-close]')&&!el.getAttribute('aria-label')?.startsWith('关闭')).at(-1);
          const uncovered=el=>{el.scrollIntoView({block:'end'});const r=el.getBoundingClientRect(),x=Math.max(1,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(1,Math.min(innerHeight-1,r.top+r.height/2)),top=document.elementFromPoint(x,y);return {label:el.textContent.trim().slice(0,80),top:r.top,bottom:r.bottom,ok:r.top>=-1&&r.bottom<=innerHeight+1&&Boolean(top&&(el.contains(top)||top.contains(el)))};};
          const content=last?uncovered(last):null;
          if(focus)focus.focus();
          const active=focus?uncovered(focus):null;
          return {content,active,scrollContainers:scrollable.length,stickyActions:[...dialog.querySelectorAll('*')].filter(el=>['sticky','fixed'].includes(getComputedStyle(el).position)).length};
        })()`);
        check("底部操作不遮挡最后内容与焦点",scrollEnd.content?.ok && scrollEnd.active?.ok,scrollEnd);
        await withDesktopKeyboardFocus(window.webContents.debugger,async()=>{
          await js("window.__rjrKeyboardEvent=null;document.addEventListener('keydown',event=>{window.__rjrKeyboardEvent={key:event.key,isTrusted:event.isTrusted};},{once:true,capture:true})");
          window.webContents.focus();
          window.webContents.sendInputEvent({type:"keyDown",keyCode:"Tab"});
          window.webContents.sendInputEvent({type:"keyUp",keyCode:"Tab"});
          await delay(80);
          const keyboard=await audit("375px 键盘焦点");
          const event=await js("window.__rjrKeyboardEvent");
          await capture("job-detail-scroll-end.png",{scenario:"底部内容与焦点"});
          check("真实键盘焦点有可读边界",Boolean(keyboard.focusState.documentFocused && event?.key==='Tab' && event.isTrusted && keyboard.focus?.ok),{focus:keyboard.focus,focusState:keyboard.focusState,event});
        });
        await escaped();
        await wait("![...document.querySelectorAll('[role=dialog]')].some(el=>el.getClientRects().length&&!el.hasAttribute('data-closed'))");
        check("岗位详情 Esc 关闭并归还触发按钮焦点",await js("document.activeElement===window.__rjrReturnFocus"));
      } finally {
        await context.repository.mutateWorkspace(w=>{delete w.evaluations[syntheticId];});
        await resizeViewport(1440);
      }
    });
    await phase("回收站预览 409 保留资料包并要求重新预览",async()=>{
      const candidate=await context.workspaceService.saveProfile({
        versionName:"合成冲突预览简历",submissionId:"self-test-preview-conflict",
        text:"合成预览冲突简历正文，本科消防工程专业，2027届，具有合成消防课程项目与机场应急管理经历。",
        profile:{major:"消防工程",education:"本科",graduationYear:2027},
      });
      await context.trashService.archive({packageId:candidate.packageId});
      await resizeViewport(375);
      await navigate("回收站");
      await click("永久删除"+candidate.versionName);
      await wait("Boolean(document.querySelector('[role=alertdialog]'))");
      check("单版本删除预览显示真实范围",await js(textHas("本次选择的版本及其全部子记录")));
      await audit("375px 永久删除确认");
      await capture("trash-preview.png",{scenario:"所选版本删除预览"});
      await context.workspaceService.saveProfile({
        versionName:"合成预览后新增简历",submissionId:"self-test-preview-revision",
        text:"合成修改修订简历正文，本科消防工程专业，2027届，具有课程项目和机场应急管理的合成经历。",
        profile:{major:"消防工程",education:"本科",graduationYear:2027},
      });
      await js(`(()=>{window.__rjrPurgeStatuses=[];const originalFetch=window.fetch;window.__rjrOriginalFetch=originalFetch;window.fetch=async(...args)=>{const response=await originalFetch(...args);if(new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href).pathname==='/api/v2/trash/purge')window.__rjrPurgeStatuses.push(response.status);return response;};})()`);
      try {
        await click("确认永久删除");
        await wait(textHas("回收站内容已变化，请关闭并重新预览"));
        check("真实 409 禁止旧预览重复提交",(await js("window.__rjrPurgeStatuses.includes(409)")) && (await js("[...document.querySelectorAll('[role=alertdialog] button')].find(el=>el.textContent.trim()==='确认永久删除')?.disabled===true")));
        check("409 未删除合成候选包",(await context.repository.read()).packages[candidate.packageId]?.state==='trashed');
        await trace("conflict","永久删除预览失效",{status:409});
        await capture("trash-preview-409.png",{scenario:"409 预览失效"});
        await click("取消");
        await click("永久删除"+candidate.versionName);
        await wait("Boolean(document.querySelector('[role=alertdialog]'))");
        await click("确认永久删除");
        await wait(textHas("永久删除完成"));
        check("重新预览后清理所选包",!(await context.repository.read()).packages[candidate.packageId]);
      } finally {
        await js("window.fetch=window.__rjrOriginalFetch;delete window.__rjrOriginalFetch");
        await resizeViewport(1440);
      }
    });
    await phase("回收站到期移除已展开正文与恢复入口",async()=>{
      await navigate("设置");
      const body="合成到期正文仅用于自测的关闭核验；本科消防工程专业，2027届，机场消防和应急管理合成课程经历。";
      const candidate=await context.workspaceService.saveProfile({
        versionName:"合成界面到期简历",submissionId:"self-test-ui-expiry",text:body,
        profile:{major:"消防工程",education:"本科",graduationYear:2027},
      });
      await context.trashService.archive({packageId:candidate.packageId});
      const deadline=Date.parse((await context.repository.read()).packages[candidate.packageId].purgeAt);
      clock.advance(Math.max(0,deadline-clock.now()-1000));
      await js(`window.__rjrOriginalDateNow=Date.now;window.__rjrRendererNow=${clock.now()};Date.now=()=>window.__rjrRendererNow`);
      try {
        await navigate("回收站");
        await click("查看内容"+candidate.versionName);
        await wait("Boolean(document.querySelector('[aria-label=版本内容摘要]'))");
        await click("简历正文");
        await wait(textHas(body));
        await capture("trash-before-expiry.png",{scenario:"到期前展开正文"});
        clock.advance(Math.max(0,deadline-clock.now()));
        await js(`window.__rjrRendererNow=${clock.now()}`);
        await wait(textHas("已到期，不能读取正文或恢复。"),5000);
        check("到期不保留已展开正文或恢复按钮",!(await js(textHas(body))) && (await js("!document.querySelector('[aria-label=版本内容摘要]')")) && !(await js(`Boolean(${locate("恢复"+candidate.versionName)})`)));
        await trace("expiry","版本到期隐藏正文与恢复入口");
        await capture("trash-expired.png",{scenario:"版本到期"});
        await escaped();
        await context.trashScheduler.sweep();
        check("界面到期合成包由既有服务清理",!(await context.repository.read()).packages[candidate.packageId]);
        await navigate("设置");
      } finally {
        await js("Date.now=window.__rjrOriginalDateNow;delete window.__rjrOriginalDateNow;delete window.__rjrRendererNow");
      }
    });
    await phase("减少动效仍显示正常合成数据",async()=>{
      const debuggerApi=window.webContents.debugger;
      const attachedHere=!debuggerApi.isAttached();
      if(attachedHere)debuggerApi.attach('1.3');
      try {
        await debuggerApi.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
        await navigate("岗位库");
        await wait(`Boolean(${locate("查看岗位")})`);
        const motion=await js(`({reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,visible:document.querySelector('main').textContent.includes('合成机场集团'),durations:[...document.querySelectorAll('main button,[role=tab],nav a')].filter(${visible}).map(el=>({label:el.textContent.trim().slice(0,50),animation:getComputedStyle(el).animationDuration,transition:getComputedStyle(el).transitionDuration}))})`);
        check("减少动效匹配且数据可见",motion.reduced && motion.visible,motion);
        const seconds=value=>value.split(',').map(item=>parseFloat(item));
        check("减少动效关闭非必要过渡",motion.durations.every(item=>[...seconds(item.animation),...seconds(item.transition)].every(value=>value<=0.01)),motion.durations);
        await capture("reduced-motion.png",{scenario:"减少动效"});
      } finally {
        await debuggerApi.sendCommand('Emulation.setEmulatedMedia',{features:[]});
        if(attachedHere)debuggerApi.detach();
      }
    });
    const archive = async (name, kind = "求职目标") => {
      await navigate(kind);
      await click("版本操作", { card: name });
      await click("移入回收站");
      await click("确认移入回收站");
      await wait(textHas("该版本已进入回收站"));
    };
    await phase("源简历永久删除后目标副本仍可运行", async () => {
      await archive(profile.versionName, "简历管理");
      await navigate("回收站");
      await click("清空整个回收站");
      await click("确认永久删除");
      await wait(textHas("永久删除完成"));
      await navigate("求职目标");
      await click("设为当前目标", { card: a.versionName });
      await navigate("工作台");
      await click("更新岗位");
      await wait(
        "document.querySelector('main').textContent.includes('岗位更新完成')",
      );
      const afterSourcePurge = await context.repository.read(),
        ownedTarget = Object.values(afterSourcePurge.targets)
          .flat()
          .find((t) => t.ownerPackageId === a.packageId);
      check(
        "源简历删除后目标副本保留",
        !afterSourcePurge.packages[profile.packageId] &&
          ownedTarget?.profileSnapshot?.ownerPackageId === a.packageId &&
          ownedTarget?.profileSnapshot?.text === profile.text &&
          Object.values(afterSourcePurge.runs).some(
            (r) => r.ownerPackageId === a.packageId && r.status === "completed",
          ),
      );
    });
    await phase("Boss 固定协议、版本隔离与风险取消排空", async () => {
      const { runBossSelfTest } = await import("./self-test-boss.mjs");
      const validation = await runBossSelfTest({
        context,
        targets: [a, b],
        dataDir,
      });
      results.push(...validation.results);
      bossContracts = validation.summary;
    });
    await phase("归档隐藏整个版本、整包恢复保持子集", async () => {
      const before = await context.repository.read(),
        counts = Object.fromEntries(
          ["jobs", "evaluations", "runs", "applications"].map((k) => [
            k,
            countRecords(before, a.packageId, k),
          ]),
        );
      await archive(a.versionName);
      await navigate("回收站");
      await capture("trash-before-restore.png",{scenario:"整包恢复前"});
      await click("恢复" + a.versionName);
      await wait(textHas("已恢复整个版本"));
      await capture("trash-restored.png",{scenario:"整包恢复"});
      const after = await context.repository.read();
      check(
        "恢复保留岗位评价检索投递完整子集",
        Object.entries(counts).every(
          ([k, n]) => countRecords(after, a.packageId, k) === n,
        ),
      );
    });
    await phase("清空回收站部分失败与安全续清理", async () => {
      await archive(a.versionName);
      await archive(b.versionName);
      controls.failCleanupRunIds = new Set(
        Object.values((await context.repository.read()).runs)
          .filter((run) => run.ownerPackageId === a.packageId)
          .map((run) => run.runId),
      );
      controls.failCleanup = true;
      await navigate("回收站");
      await click("清空整个回收站");
      await click("确认永久删除");
      await wait(textHas("清理失败，可重试"));
      check(
        "部分失败如实显示",
        await js(
          "document.body.textContent.includes('失败 1')&&document.body.textContent.includes('已完成 1')",
        ),
      );
      await capture("trash-partial-failure.png",{scenario:"部分永久删除失败"});
      controls.failCleanup = false;
      await click("重试清理");
      await wait(textHas("回收站为空"));
      check(
        "续清理实际清除子集",
        !Object.values((await context.repository.read()).jobs).some(
          (j) => j.ownerPackageId === a.packageId,
        ),
      );
    });
    await phase("72 小时到期清理服务", async () => {
      const p = await context.workspaceService.saveProfile({
        versionName: "合成到期简历",
        submissionId: "self-test-expiry",
        text: "合成到期简历正文，消防工程专业，本科学历，合成课程与项目经历。",
        profile: { major: "消防工程", education: "本科", graduationYear: 2027 },
      });
      await context.trashService.archive({ packageId: p.packageId });
      clock.advance(72 * 3600 * 1000);
      await context.trashScheduler.sweep();
      check(
        "72小时到期正文与身份已清除",
        !(await context.repository.read()).packages[p.packageId],
      );
    });
    await phase("响应式窗口、长中文与字体放大截图", async () => {
      for (const width of [375, 768, 1024, 1440]) {
        const sizing = await resizeViewport(width);
        await js("location.hash='#/settings'");
        await wait("document.querySelector('h1')?.textContent==='设置'");
        await wait("Boolean(document.getElementById('model.model'))");
        const geometry = {
          ...sizing,
          ...(await js(
            "({width:innerWidth,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth+1})",
          )),
        };
        check(
          "请求" + width + "px / 实际" + geometry.width + "px 无页面横向溢出",
          !geometry.overflow,
          geometry,
        );
        const filename = `ui-${width}-${String(geometry.dpr).replace(".", "_")}.png`;
        await capture(filename,{scenario:"字体与长中文",sizing});
      }
      window.webContents.setZoomFactor(1.25);
      await delay(200);
      check(
        "字体放大125%无页面横向溢出",
        await js("document.documentElement.scrollWidth<=innerWidth+1"),
      );
      const filename = "ui-font-125.png";
      await capture(filename,{fontZoom:1.25,scenario:"字体放大125%"});
      window.webContents.setZoomFactor(1);
    });
    const issues = await js("window.__rjrSelfTestIssues||[]");
    check(
      "CSP、渲染器错误与控制台错误为零",
      issues.length === 0 && rendererErrors.length === 0,
      { issues, rendererErrors },
    );
    check("外部网络请求为零", networkGuard.report().externalRequests === 0);
  } catch (error) {
    if (!results.some((r) => !r.ok))
      results.push({
        name: "self-test",
        ok: false,
        error: String(error.message).slice(0, 500),
      });
  }
  return {
    schemaVersion: 2,
    synthetic: true,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    screenshots,
    interactions,
    visualAudits,
    bossContracts,
    network: networkGuard.report(),
    deviceScaleFactor: await js("devicePixelRatio"),
    rendererErrors,
    externalIntents,
  };
}
