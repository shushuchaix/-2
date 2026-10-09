// Standalone synthetic Electron exercise. No daily profile or external transport.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.versions.electron) {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "rjr-collection-electron-"),
  );
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(
      path.join(root, "node_modules/electron/dist/electron.exe"),
      [fileURLToPath(import.meta.url), temp],
      { cwd: root, windowsHide: true, timeout: 90000, encoding: "utf8", env },
    );
    const report = path.join(temp, "report.json");
    if (fs.existsSync(report)) {
      console.log(fs.readFileSync(report, "utf8"));
      process.exitCode = child.status ?? 1;
    } else {
      console.error(
        "Synthetic Electron produced no report.",
        child.status,
        child.error?.message,
        fs.existsSync(path.join(temp, "phase.txt"))
          ? fs.readFileSync(path.join(temp, "phase.txt"), "utf8")
          : "before main",
        child.stderr.slice(-2000),
      );
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow, session, safeStorage } = await import("electron");
  const { createCollectionBrowser } = await import(
    "../electron/collection/browser.mjs"
  );
  const { createCollectionSessions } = await import(
    "../electron/collection/sessions.mjs"
  );
  const { createEgressProxy } = await import(
    "../src/infrastructure/collection/egress-proxy.mjs"
  );
  const temp = process.argv[2],
    scopes = [
      { packageId: "synthetic-a", targetRevisionId: "synthetic-ta" },
      { packageId: "synthetic-b", targetRevisionId: "synthetic-tb" },
    ];
  assert.ok(path.basename(temp).startsWith("rjr-collection-electron-"));
  app.setPath("userData", path.join(temp, "profile"));
  const phase = (value) =>
    fs.writeFileSync(path.join(temp, "phase.txt"), value);
  phase("main loaded");
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => {
    let browser,
      failed = 0;
    const checks = [];
    phase("app ready");
    try {
      const patched = new Set(),
        options = [];
      let mode = "challenge",
        requests = 0;
      const safeSession = {
        fromPartition(partition, input) {
          const ses = session.fromPartition(partition, input);
          if (!patched.has(partition)) {
            patched.add(partition);
            ses.protocol.handle(
              "https",
              (request) =>
                new Response(
                  request.url.includes("/detail/")
                    ? mode === "challenge"
                      ? '<title>安全验证</title><div id="captcha"></div><script>window.boot={"text":""}</script>'
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
      const store = createCollectionSessions({ dataDir: temp, safeStorage });
      browser = createCollectionBrowser({
        BrowserWindow: HiddenWindow,
        session: safeSession,
        sessionStore: store,
        egressProxy: createEgressProxy({
          resolvePublicUrl: async () => {
            throw Error("synthetic_external_transport_forbidden");
          },
        }),
        offlineAllows: (url) =>
          /^https:\/\/(?:weibo.com\/login.php|m.weibo.cn\/detail\/123)$/.test(
            url,
          ),
        ledger: {
          reserve: async (input) => {
            requests += input.requestUpperBound;
            return { reservationId: input.reservationId };
          },
          settle: async () => {},
        },
      });
      phase("opening");
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
      phase("opened");
      assert.notEqual(
        options[0].webPreferences.partition,
        options[1].webPreferences.partition,
      );
      for (const option of options) {
        assert.equal(option.webPreferences.nodeIntegration, false);
        assert.equal(option.webPreferences.preload, undefined);
        assert.equal(option.webPreferences.sandbox, true);
      }
      checks.push("isolated remote windows without workbench bridge");
      const input = {
        ref: { scope: scopes[0], activityId: "synthetic-root" },
        sessionRef: a.sessionRef,
        testUrl: "https://m.weibo.cn/detail/123",
        token: {},
        operationLease: {},
      };
      phase("verifying");
      assert.equal((await browser.verifySession(input)).state, "unverified");
      checks.push("HTTP200 challenge stays unverified");
      mode = "body";
      assert.equal((await browser.verifySession(input)).state, "verified");
      checks.push("nonempty DOM body is verified");
      phase("verified");
      await browser.closePackage(scopes[0].packageId);
      await assert.rejects(
        store.get({ scope: scopes[0], sessionRef: a.sessionRef }),
      );
      assert.equal(
        (await store.get({ scope: scopes[1], sessionRef: b.sessionRef })).state,
        "unverified",
      );
      checks.push("package cleanup preserves the other package");
      assert.equal(browser.snapshot().activeReads, 0);
      await browser.stop();
      assert.equal(browser.snapshot().windows, 0);
      checks.push("shutdown drains windows and read slots");
    } catch (e) {
      failed = 1;
      checks.push({ failed: e.code || e.name, message: e.message });
    } finally {
      await browser?.stop();
      fs.writeFileSync(
        path.join(temp, "report.json"),
        JSON.stringify({ failed, checks }, null, 2),
      );
      app.exit(failed);
    }
  });
}
