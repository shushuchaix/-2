import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import fsAsync from "node:fs/promises";
import { randomUUID } from "node:crypto";

const marker = ".rjr-self-test";
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
  const controls = { hold: false, failCleanup: false };
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
      if (controls.hold)
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
        if (controls.failCleanup && /[\\/]runs-v2[\\/]/.test(filename))
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
    origin = new URL(window.webContents.getURL()).origin;
  const js = (source) => window.webContents.executeJavaScript(source, true);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (name, ok, details) => {
    results.push({ name, ok: Boolean(ok), ...(details ? { details } : {}) });
    if (!ok) throw Error(name);
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
  };
  const input = async (label, value) => {
    await wait(
      `Boolean(document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']')||[...document.querySelectorAll('label')].find(el=>el.getClientRects().length>0&&!el.closest('[data-closed],[inert],[aria-hidden=true]')&&el.textContent.trim()===${JSON.stringify(label)}))`,
    );
    await js(
      `(()=>{const label=${JSON.stringify(label)}, node=document.querySelector('[aria-label='+CSS.escape(label)+']')||[...document.querySelectorAll('input,textarea')].find(node=>node.getClientRects().length>0&&!node.closest('[data-closed],[inert],[aria-hidden=true]')&&node.id===[...document.querySelectorAll('label')].find(el=>el.getClientRects().length>0&&!el.closest('[data-closed],[inert],[aria-hidden=true]')&&el.textContent.trim()===label)?.htmlFor);if(!node)throw Error('missing field '+label);node.focus();const prototype=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await delay(60);
  };
  const escaped = async () => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await delay(100);
  };
  const navigate = async (label) => {
    await click(label, { selector: "nav a" });
    await wait(
      `document.querySelector('h1')?.textContent.trim()===${JSON.stringify(label)}`,
    );
  };
  const resizeViewport = async (width, height = 900) => {
    let requested = width;
    for (let attempt = 0; attempt < 4; attempt++) {
      window.setContentSize(requested, height);
      await delay(250);
      const actual = await js("innerWidth");
      if (actual === width) return;
      requested += width - actual;
    }
    throw Error("self_test_viewport_width_mismatch: " + width);
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
        fs.writeFileSync(
          path.join(dataDir, "failure.png"),
          (await window.webContents.capturePage()).toPNG(),
        );
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
  let a, b, profile;
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
          countRecords(w, a.packageId, "runs") === 1,
      );
      await navigate("岗位库");
      await click("查看岗位");
      await wait(textHas("本版本招聘事实"));
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
        await wait(`Boolean(${locate("取消任务")})`);
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
      await wait(`Boolean(${locate("取消任务")})`);
      check(
        "导航回来恢复活跃任务并禁用重复启动",
        (await js(
          "[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='更新岗位')?.disabled === true",
        )) &&
          countRecords(await context.repository.read(), a.packageId, "runs") ===
            heldRunCount,
      );
      await click("取消任务");
      await wait(textHas("任务已取消"));
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
        await resizeViewport(width);
        const geometry = await js(
          "({width:innerWidth,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth+1})",
        );
        check(
          "岗位库" + width + "px 无页面横向溢出",
          !geometry.overflow,
          geometry,
        );
        const file =
          "jobs-" +
          width +
          "-" +
          String(geometry.dpr).replace(".", "_") +
          ".png";
        fs.writeFileSync(
          path.join(dataDir, file),
          (await window.webContents.capturePage()).toPNG(),
        );
        screenshots.push({ file, ...geometry });
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
      window.setContentSize(1440, 900);
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
      await navigate("招聘来源");
      await click("检查来源");
      await wait(textHas("来源检查已完成"));
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
              "copyDataLocation",
              "deleteKey",
              "getDataLocations",
              "getKeyStatus",
              "isAvailable",
              "openDataLocation",
              "reportDiagnostic",
              "saveKey",
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
      await click("恢复" + a.versionName);
      await wait(textHas("已恢复整个版本"));
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
      controls.failCleanup = true;
      await navigate("回收站");
      await click("清空整个回收站");
      await click("确认永久删除");
      await wait(textHas("清理待重试"));
      check(
        "部分失败如实显示",
        await js(
          "document.body.textContent.includes('失败 1')&&document.body.textContent.includes('已完成 1')",
        ),
      );
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
        await resizeViewport(width);
        await js("location.hash='#/settings'");
        await wait("document.querySelector('h1')?.textContent==='设置'");
        await wait("Boolean(document.getElementById('model.model'))");
        const geometry = await js(
          "({width:innerWidth,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth+1})",
        );
        check(width + "px 无页面横向溢出", !geometry.overflow, geometry);
        const filename = `ui-${width}-${String(geometry.dpr).replace(".", "_")}.png`;
        fs.writeFileSync(
          path.join(dataDir, filename),
          (await window.webContents.capturePage()).toPNG(),
        );
        screenshots.push({ file: filename, ...geometry });
      }
      window.webContents.setZoomFactor(1.25);
      await delay(200);
      check(
        "字体放大125%无页面横向溢出",
        await js("document.documentElement.scrollWidth<=innerWidth+1"),
      );
      const filename = "ui-font-125.png";
      fs.writeFileSync(
        path.join(dataDir, filename),
        (await window.webContents.capturePage()).toPNG(),
      );
      screenshots.push({ file: filename, fontZoom: 1.25 });
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
    network: networkGuard.report(),
    deviceScaleFactor: await js("devicePixelRatio"),
    rendererErrors,
    externalIntents,
  };
}
