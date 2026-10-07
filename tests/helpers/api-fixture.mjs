import { once } from "node:events";
import { createServer } from "../../src/server.mjs";
import { loadConfig } from "../../src/config.mjs";
import { fakeProvider } from "./fake-sources.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
import { createTempDir } from "./fixtures.mjs";
import { allowLocalOrigin } from "./network-guard.mjs";
export async function apiFixture(t,options={}) {
  const dataDir = options.dataDir||await createTempDir(t),
    cfg = loadConfig({ quiet: true, dataDir });
  cfg.auth.mode = "none";
  cfg.limits.perIpCooldownMs = 0;
  cfg.limits.dailyPerIp = 100;
  cfg.deepseek.apiKey = "";
  const providers=options.providers||[fakeProvider()];
  cfg.sources = { ...cfg.sources, synthetic: { enabled: true } };
  const ctx = createServer(cfg, {
    dataDir,
    dependencies: {
      registry: createSourceRegistry(providers),
      catalog: providers.map(provider=>({siteId:provider.id+'-1',providerId:provider.id,category:'job_board',name:'合成源',origin:'https://example.com',status:'ready'})),
      requestFactory: () => async () => {
        throw Error("Unexpected network");
      },
    },
  });
  ctx.server.listen(0, "127.0.0.1");
  await once(ctx.server, "listening");
  const origin = "http://127.0.0.1:" + ctx.server.address().port;
  allowLocalOrigin(origin);
  t.after(async () => {
    ctx.server.closeAllConnections();
    await new Promise((resolve) => ctx.server.close(resolve));
  });
  // Static asset requests do not wait for application startup in the server.
  // Finish migration before a fixture can be torn down by its first test.
  await ctx.ready;
  const call = async (url, body, method) => {
    const response = await fetch(origin + url, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
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
  return { ctx, cfg, dataDir, origin, call };
}
