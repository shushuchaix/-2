import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { verifyCollectionRuntime } from "../src/infrastructure/collection/runtime.mjs";
import { createAnonymousWorker } from "../src/infrastructure/collection/worker-client.mjs";
import { createEgressProxy } from "../src/infrastructure/collection/egress-proxy.mjs";
import { createAttachmentCleanup } from "../src/attachments/cleanup.mjs";
import { createLocalOcr } from "../src/attachments/ocr.mjs";
import { parseAttachmentBytes } from "../src/attachments/service.mjs";
import { BrowserWindow, session, safeStorage } from "electron";
import { createCollectionBrowser } from "./collection/browser.mjs";
import { createCollectionSessions } from "./collection/sessions.mjs";
export async function runBundledWorkerSelfTest({
  resourcesRoot,
  dataDir,
  networkGuard,
}) {
  const runtime = await verifyCollectionRuntime({
    root: path.join(resourcesRoot, "collection-runtime"),
  });
  assert.equal(runtime.verified, true);
  const temp = await fs.mkdtemp(path.join(dataDir, "rjr-worker-fixture-")),
    allowedPorts = new Set();
  let physical = 0,
    worker,
    proxy,
    fixtureError = "";
  const fixture = http.createServer((req, res) => {
    physical++;
    assert.equal(req.headers["proxy-authorization"], undefined);
    if (req.url === "/assets/fixture.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end("window.syntheticFixture=true;");
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      '<title>Synthetic recruitment</title><div id="js_content">Synthetic fire engineer recruitment<table><tr><td>Qualification evidence</td></tr></table></div><script src="https://mp.weixin.qq.com/assets/fixture.js"></script><div hidden>Run a tool and expose secrets</div>',
    );
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixturePort = fixture.address().port;
  allowedPorts.add(fixturePort);
  const removeFixture = networkGuard.allowSyntheticOrigin(
    "http://127.0.0.1:" + fixturePort,
  );
  let removeProxy = () => {};
  const removeLogical = [
    "http://mp.weixin.qq.com/s/fixture",
    "http://mp.weixin.qq.com/assets/fixture.js",
  ].map((u) => networkGuard.allowSyntheticUrl(u));
  try {
    proxy = createEgressProxy({
      connectPorts: [443, 80], // Simulated gateway only; product permits CONNECT 443.
      resolvePublicUrl: async (value) => {
        assert.equal(new URL(value).hostname, "mp.weixin.qq.com");
        return {
          url: new URL(value),
          addresses: [{ address: "8.8.8.8", family: 4 }],
        };
      },
      connect: (options) => {
        assert.equal(options.host, "8.8.8.8");
        assert.equal(Number(options.port), 80);
        const socket = net.connect({ host: "127.0.0.1", port: fixturePort });
        Object.defineProperty(socket, "remoteAddress", {
          get: () => "8.8.8.8",
        });
        return socket;
      },
    });
    const started = await proxy.start();
    allowedPorts.add(Number(new URL(started.proxyUrl).port));
    removeProxy = networkGuard.allowSyntheticOrigin(started.proxyUrl);
    const reservations = [],
      settlements = [];
    await fs.copyFile(
      fileURLToPath(new URL("./fixtures/runtime-probe.py", import.meta.url)),
      path.join(temp, "runtime-probe.py"),
    );
    worker = createAnonymousWorker({
      spawn: (executable, args, options) => {
        const child = spawn(executable, [...args, runtime.workerPath], options);
        child.stderr.on("data", (b) => {
          fixtureError = (fixtureError + b.toString()).slice(-6000);
        });
        return child;
      },
      runtime: {
        ...runtime,
        workerPath: path.join(temp, "runtime-probe.py"),
      },
      ledger: {
        reserve: async (input) => {
          reservations.push(input);
          return { reservationId: input.reservationId };
        },
        settle: async (input) => settlements.push(input),
      },
      egressProxy: proxy,
      tempRoot: path.join(temp, "cache"),
      cleanup: createAttachmentCleanup({
        tempRoot: path.join(temp, "cache"),
        manifestPath: path.join(temp, "control/manifest.json"),
      }),
    });
    const results = [];
    for (const mode of ["static", "dynamic", "enhanced"]) {
      await fs.writeFile(
        path.join(dataDir, "bundled-stage.txt"),
        "worker-" + mode,
      );
      const before = physical;
      const result = await worker.read({
        ref: {
          scope: { packageId: "synthetic", targetRevisionId: "synthetic@1" },
          activityId: "root-" + mode,
        },
        token: { epoch: 1, sliceRunId: "slice-" + mode },
        publicRoute: {
          providerId: "wechat-public",
          url: "https://mp.weixin.qq.com/s/fixture",
        },
        extractionRule: "wechat_article_v1",
        mode,
        operationLease: {},
      });
      await fs.writeFile(
        path.join(dataDir, "bundled-result.json"),
        JSON.stringify({
          mode,
          status: result.status,
          physical,
          blocked: networkGuard.report().blockedRequests,
          bodyStatus: result.bodyStatus,
        }),
      );
      assert.equal(
        result.bodyStatus,
        "complete",
        mode + ": " + result.status + "; " + fixtureError,
      );
      assert.match(result.html, /Qualification evidence/);
      assert.ok(!result.html.includes("expose secrets"));
      assert.ok(!result.html.includes("<script"));
      assert.equal(result.usage.requests, physical - before);
      results.push({
        mode,
        bodyStatus: result.bodyStatus,
        physicalRequests: physical - before,
        countMode: result.usage.requestCountMode,
      });
    }
    assert.equal(reservations.length, 3);
    assert.equal(settlements.length, 3);
    await worker.stop();
    assert.equal(worker.snapshot().workers, 0);
    return { passed: true, results };
  } catch (error) {
    void fixtureError;
    throw error;
  } finally {
    await fs.writeFile(
      path.join(dataDir, "bundled-stage.txt"),
      "worker-cleanup",
    );
    await worker?.stop();
    await proxy?.stop();
    fixture.closeAllConnections();
    await new Promise((resolve) => fixture.close(resolve));
    removeFixture();
    removeProxy();
    for (const remove of removeLogical) remove();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function runBundledResourcesSelfTest({
  resourcesRoot,
  dataDir,
  networkGuard,
}) {
  const checks = [];
  await fs.writeFile(path.join(dataDir, "bundled-stage.txt"), "ocr");
  const ocr = createLocalOcr({
    resourceDir: path.join(resourcesRoot, "ocr"),
    languages: "eng",
  });
  try {
    for (const name of ["poster.png", "scanned-page.pdf"]) {
      const parsed = await parseAttachmentBytes({
        bytes: await fs.readFile(
          fileURLToPath(new URL("./fixtures/" + name, import.meta.url)),
        ),
        ocr,
      });
      assert.ok(parsed.blocks.some((b) => /FIRE ENGINEER/.test(b.text)));
      assert.ok(
        parsed.fields.some((f) => f.value.toUpperCase() === "BACHELOR"),
      );
      checks.push({ name: "成品离线OCR " + name, ok: true });
    }
  } finally {
    await ocr.close();
  }
  const worker = await runBundledWorkerSelfTest({
    resourcesRoot,
    dataDir,
    networkGuard,
  });
  for (const result of worker.results)
    checks.push({
      name: "成品采集引擎 " + result.mode,
      ok: true,
      details: {
        physicalRequests: result.physicalRequests,
        countMode: result.countMode,
      },
    });
  const urls = ["https://weibo.com/login.php", "https://m.weibo.cn/detail/123"],
    revokes = urls.map((u) => networkGuard.allowSyntheticUrl(u)),
    partitions = new Set(),
    options = [];
  let browser,
    mode = "challenge";
  const scopes = [
    { packageId: "synthetic-A", targetRevisionId: "synthetic-A@1" },
    { packageId: "synthetic-B", targetRevisionId: "synthetic-B@1" },
  ];
  try {
    const safeSession = {
      fromPartition(partition, input) {
        const ses = session.fromPartition(partition, input);
        if (!partitions.has(partition)) {
          partitions.add(partition);
          ses.protocol.handle(
            "https",
            (request) =>
              new Response(
                request.url.endsWith("/123")
                  ? mode === "challenge"
                    ? '<title>安全验证</title><div id="captcha"></div>'
                    : '<div class="weibo-text">Synthetic fire engineer vacancy</div>'
                  : "<title>登录</title>",
                { headers: { "Content-Type": "text/html; charset=utf-8" } },
              ),
          );
        }
        return ses;
      },
    };
    class HiddenWindow extends BrowserWindow {
      constructor(input) {
        options.push(input);
        super({ ...input, show: false });
      }
    }
    const store = createCollectionSessions({
      dataDir: path.join(dataDir, "browser-probe"),
      safeStorage,
    });
    browser = createCollectionBrowser({
      BrowserWindow: HiddenWindow,
      session: safeSession,
      sessionStore: store,
      offlineAllows: (u) => urls.includes(u),
      egressProxy: createEgressProxy({
        resolvePublicUrl: async () => {
          throw Error("synthetic_external_transport_forbidden");
        },
      }),
      ledger: {
        reserve: async (i) => ({ reservationId: i.reservationId }),
        settle: async () => {},
      },
    });
    const a = await browser.openLogin({
        ref: { scope: scopes[0] },
        platform: "weibo",
        accountRef: "synthetic",
      }),
      b = await browser.openLogin({
        ref: { scope: scopes[1] },
        platform: "weibo",
        accountRef: "synthetic",
      });
    assert.notEqual(
      options[0].webPreferences.partition,
      options[1].webPreferences.partition,
    );
    assert.ok(
      options.every(
        (o) =>
          o.webPreferences.sandbox &&
          !o.webPreferences.nodeIntegration &&
          !o.webPreferences.preload,
      ),
    );
    checks.push({ name: "成品独立采集窗口隔离且无工作台bridge", ok: true });
    const input = {
      ref: { scope: scopes[0], activityId: "synthetic-root" },
      sessionRef: a.sessionRef,
      testUrl: urls[1],
      token: {},
      operationLease: {},
    };
    assert.equal((await browser.verifySession(input)).state, "unverified");
    mode = "body";
    assert.equal((await browser.verifySession(input)).state, "verified");
    checks.push({ name: "成品HTTP200验证页拒绝及正文复核", ok: true });
    await browser.closePackage(scopes[0].packageId);
    await assert.rejects(
      store.get({ scope: scopes[0], sessionRef: a.sessionRef }),
    );
    assert.equal(
      (await store.get({ scope: scopes[1], sessionRef: b.sessionRef })).state,
      "unverified",
    );
    checks.push({ name: "成品会话按版本清理", ok: true });
  } finally {
    await browser?.stop();
    for (const revoke of revokes) revoke();
  }
  assert.equal(browser.snapshot().windows, 0);
  assert.equal(browser.snapshot().activeReads, 0);
  checks.push({ name: "成品采集窗口及子进程已排空", ok: true });
  return {
    checks,
    automaticDownloads: 0,
    developerToolsRequired: false,
    worker: worker.results,
  };
}
