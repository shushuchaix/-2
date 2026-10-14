import test from "node:test";
import assert from "node:assert/strict";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { createCollectionPublicResolver } from "../../electron/collection/public-dns.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";

const scope = {
  packageId: "synthetic-login",
  targetRevisionId: "synthetic-target",
};
function fixture(
  t,
  { failLoad = false, delayLoad = false, failDns = false } = {},
) {
  const base = collectionBrowserFixture(),
    entries = new Map(),
    events = [],
    saved = [];
  let clientOptions,
    dnsReads = 0,
    resolverClosed = false;
  let releaseLoad, reachedLoad;
  const loaded = new Promise((resolve) => {
    reachedLoad = resolve;
  });
  const release = new Promise((resolve) => {
    releaseLoad = resolve;
  });
  const egressProxy = {
    ...base.egressProxy,
    createClient(options) {
      clientOptions = options;
      return base.egressProxy.createClient(options);
    },
  };
  const store = {
    create: async ({ scope, platform, remember }) => {
      const entry = {
        ...scope,
        sessionRef: "synthetic-session",
        platform,
        partition: "synthetic-login-partition",
        remember,
      };
      entries.set(entry.sessionRef, entry);
      return entry;
    },
    readMaterial: async () => ({ cookies: [] }),
    saveMaterial: async () => {},
    setState: async () => {},
    clear: async ({ sessionRef }) => {
      entries.delete(sessionRef);
      return { status: "cleared" };
    },
  };
  class BrowserWindow extends base.BrowserWindow {
    async loadURL(url) {
      await super.loadURL(url);
      if (failLoad)
        throw Object.assign(Error("Failed to load private URL and account"), {
          code: "ERR_TUNNEL_CONNECTION_FAILED",
          errno: -111,
        });
      let result;
      try {
        result = await clientOptions.resolvePublicUrl(url);
      } catch {
        throw Object.assign(Error("private URL and account"), {
          code: "ERR_TUNNEL_CONNECTION_FAILED",
          errno: -111,
        });
      }
      assert.deepEqual(result.addresses, [{ address: "8.8.8.8", family: 4 }]);
      reachedLoad();
      if (delayLoad) await release;
    }
  }
  const browser = createCollectionBrowser({
    ...base,
    BrowserWindow,
    egressProxy,
    sessionStore: store,
    ledger: {
      reserve: async () => {
        throw Error(
          "manual login must not open or mutate a collection activity",
        );
      },
    },
    rememberSession: async (input) => saved.push(input),
    diagnostics: {
      record: async (event, error) => {
        events.push({ event, error });
        return { diagnosticId: "d-11111111-1111-1111-1111-111111111111" };
      },
    },
    publicResolverFactory(input) {
      const resolver = createCollectionPublicResolver({
        ...input,
        lookup: async () => [{ address: "198.18.0.1", family: 4 }],
        transport: async (request) => {
          dnsReads++;
          if (failDns)
            throw Object.assign(Error("private resolver message"), {
              code: "ABORT_ERR",
              cause: Object.assign(Error("private timeout"), {
                name: "TimeoutError",
              }),
            });
          return {
            status: 200,
            text: JSON.stringify({
              Status: 0,
              Answer:
                request.url.searchParams.get("type") === "A"
                  ? [{ type: 1, data: "8.8.8.8", TTL: 30 }]
                  : [],
            }),
          };
        },
      });
      const close = resolver.close;
      resolver.close = async () => {
        await close();
        resolverClosed = true;
      };
      return resolver;
    },
  });
  t.after(() => browser.stop());
  return {
    browser,
    entries,
    events,
    saved,
    base,
    clientOptions: () => clientOptions,
    dnsReads: () => dnsReads,
    resolverClosed: () => resolverClosed,
    loaded,
    releaseLoad,
  };
}

test("manual login corrects system Fake-IP in its own bounded resolver and drains on close", async (t) => {
  const f = fixture(t);
  const result = await f.browser.openLogin({
    ref: { scope },
    platform: "boss",
    accountRef: "boss",
  });
  assert.equal(result.state, "unverified");
  assert.equal(f.base.windows[0].url, "https://www.zhipin.com/web/user/");
  assert.equal(f.dnsReads(), 2);
  assert.equal(f.saved.length, 1);
  await f.browser.stop();
  assert.equal(f.resolverClosed(), true);
  const finished = f.events.findLast(
    (x) => x.event.operation === "collection.finish",
  );
  assert.equal(finished.event.counts.manualRequests, 3);
  assert.ok(finished.event.counts.manualBytes > 0);
  assert.equal(f.base.windows[0].isDestroyed(), true);
});

test("manual DNS and page requests share the 60-request window limit", async (t) => {
  const f = fixture(t);
  await f.browser.openLogin({
    ref: { scope },
    platform: "boss",
    accountRef: "boss",
  });
  assert.equal(typeof f.clientOptions().resolvePublicUrl, "function");
  const win = f.base.windows[0],
    ses = win.webContents.session;
  const authorize = (n) =>
    new Promise((resolve) =>
      ses.before(
        {
          url: "https://www.zhipin.com/assets/synthetic-" + n + ".js",
          method: "GET",
          resourceType: "script",
          webContentsId: win.webContents.id,
        },
        resolve,
      ),
    );
  for (let n = 0; n < 28; n++)
    await f
      .clientOptions()
      .resolvePublicUrl("https://public-" + n + ".example.org/");
  await assert.rejects(
    f.clientOptions().resolvePublicUrl("https://last.example.org/"),
    { code: "collection_login_budget_exhausted" },
  );
  assert.equal((await authorize(58)).cancel, true);
  assert.ok(f.dnsReads() <= 59);
});

test("a failed login navigation reports its error and removes the blank window and unsaved reference", async (t) => {
  const f = fixture(t, { failLoad: true });
  await assert.rejects(
    f.browser.openLogin({
      ref: { scope },
      platform: "boss",
      accountRef: "boss",
    }),
    { code: "collection_login_load_failed" },
  );
  assert.equal(f.saved.length, 0);
  assert.equal(f.entries.size, 0);
  assert.equal(f.base.windows[0].isDestroyed(), true);
  assert.equal(f.resolverClosed(), true);
  const event = f.events.find(
    (x) =>
      x.event.outcome === "failed" &&
      x.event.code === "collection_login_load_failed",
  );
  assert.ok(event);
  assert.equal(event.event.errorNumber, -111);
  assert.doesNotMatch(
    JSON.stringify(event),
    /private URL|account|ERR_TUNNEL_CONNECTION_FAILED/,
  );
});

test("closing a loading login window cannot save a late successful session reference", async (t) => {
  const f = fixture(t, { delayLoad: true });
  const opening = f.browser.openLogin({
    ref: { scope },
    platform: "boss",
    accountRef: "boss",
  });
  const rejected = assert.rejects(opening, {
    code: "collection_cancelled",
  });
  await f.loaded;
  await f.browser.stop();
  f.releaseLoad();
  await rejected;
  assert.equal(f.saved.length, 0);
  assert.equal(f.entries.size, 0);
});

test("a failed login DNS connection reports a safe cause, scope and error number in user feedback", async (t) => {
  const f = fixture(t, { failDns: true });
  const error = await f.browser
    .openLogin({ ref: { scope }, platform: "boss", accountRef: "boss" })
    .then(
      () => assert.fail("must reject"),
      (e) => e,
    );
  assert.equal(error.code, "collection_login_load_failed");
  assert.match(error.message, /域名解析超时/);
  assert.match(error.message, /d-11111111-1111-1111-1111-111111111111/);
  const e = f.events.find(
    (v) => v.event.code === "collection_login_load_failed",
  );
  assert.equal(e.event.failurePhase, "dns");
  assert.equal(e.event.sourceId, "boss");
  assert.equal(e.event.siteId, "boss");
  assert.equal(e.event.errorNumber, -111);
  assert.equal(e.error.cause.code, "request_timeout");
  assert.equal(f.saved.length, 0);
  assert.equal(f.entries.size, 0);
  assert.equal(f.resolverClosed(), true);
  assert.doesNotMatch(
    JSON.stringify(e),
    /private URL|account|private timeout|private resolver/,
  );
});
