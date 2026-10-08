import { once } from "node:events";
import { createServer } from "../../src/server.mjs";
import { loadConfig } from "../../src/config.mjs";
import { fakeProvider } from "./fake-sources.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createTempDir, registerTestResource } from "./fixtures.mjs";
import { allowLocalOrigin } from "./network-guard.mjs";
import { hashPassword } from "../../src/auth.mjs";
export async function apiFixture(t, options = {}) {
  const dataDir = options.dataDir || (await createTempDir(t)),
    cfg = loadConfig({ quiet: true, dataDir });
  const password = "synthetic-auth-only-password";
  cfg.auth.mode = options.authRequired ? "password" : "none";
  cfg.__envAuthPassword = "";
  cfg.__authSecret = "synthetic-api-fixture-session-secret";
  if (options.authRequired) cfg.auth.passwordHash = hashPassword(password);
  cfg.limits.perIpCooldownMs = 0;
  cfg.limits.dailyPerIp = 100;
  cfg.deepseek.apiKey = "";
  const providers = options.providers || [fakeProvider()];
  cfg.sources = { ...cfg.sources, synthetic: { enabled: true } };
  const ctx = createServer(cfg, {
    dataDir,
    dependencies: {
      legacySchema: options.legacySchema !== false,
      registry: createSourceRegistry(providers),
      catalog: providers.map((provider) => ({
        siteId: provider.id + "-1",
        providerId: provider.id,
        category: "job_board",
        name: "合成源",
        origin: "https://example.com",
        status: "ready",
      })),
      requestFactory: () => async () => {
        throw Error("Unexpected network");
      },
      ...options.dependencies,
    },
  });
  ctx.server.listen(0, "127.0.0.1");
  await once(ctx.server, "listening");
  const origin = "http://127.0.0.1:" + ctx.server.address().port;
  allowLocalOrigin(origin);
  registerTestResource(t, async () => {
    await (await ctx.ready).close?.();
    ctx.server.closeAllConnections();
    await new Promise((resolve) => ctx.server.close(resolve));
    await ctx.diagnostics.list({ limit: 1 });
  });
  // Static asset requests do not wait for application startup in the server.
  // Finish migration before a fixture can be torn down by its first test.
  await ctx.ready;
  const request = async (url, body, method, cookie) => {
    const response = await fetch(origin + url, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { response, data, text };
  };
  const call = (url, body, method) => request(url, body, method);
  let cookie;
  const callAuthenticated = async (url, body, method) => {
    if (options.authRequired && !cookie) {
      const login = await call("/api/login", { password });
      if (login.response.status !== 200) throw Error("Synthetic login failed");
      cookie = login.response.headers.get("set-cookie")?.split(";")[0];
      if (!cookie)
        throw Error("Synthetic login did not set a production session cookie");
    }
    return request(url, body, method, cookie);
  };
  return { ctx, cfg, dataDir, origin, call, callAuthenticated };
}
