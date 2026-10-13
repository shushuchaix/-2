import test from "node:test";
import assert from "node:assert/strict";
import { collectionFixture } from "../helpers/collection-fixture.mjs";
import { collectionBrowserFixture } from "../helpers/collection-browser-fixture.mjs";
import { createCollectionBrowser } from "../../electron/collection/browser.mjs";
import { platformPolicy } from "../../electron/collection/network-policy.mjs";

async function readFixture(t, { redirect = false, failed = false } = {}) {
  const f = await collectionFixture(t),
    c = await f.openCommit();
  const fixture = collectionBrowserFixture({
    executeJavaScript: async () => ({
      html: '<div class="weibo-text">公开招聘正文</div>',
      selectorFound: true,
    }),
  });
  const fromPartition = fixture.session.fromPartition.bind(fixture.session);
  fixture.session.fromPartition = (partition, options) => {
    const ses = fromPartition(partition, options);
    ses.webRequest.onCompleted = (filter, callback) => {
      ses.completed = filter === null ? null : callback;
    };
    ses.webRequest.onErrorOccurred = (filter, callback) => {
      ses.failed = filter === null ? null : callback;
    };
    return ses;
  };
  class BrowserWindow extends fixture.BrowserWindow {
    async loadURL(url) {
      this.url = url;
      const ses = this.webContents.session;
      const details = {
        id: 7,
        url,
        method: "GET",
        resourceType: "mainFrame",
        webContentsId: this.webContents.id,
      };
      const authorize = async (value) => {
        const result = await new Promise((resolve) =>
          ses.before(value, resolve),
        );
        assert.equal(result.cancel, false);
      };
      await authorize(details);
      if (redirect)
        await authorize({ ...details, url: "https://m.weibo.cn/detail/456" });
      if (failed) {
        ses.failed?.({ ...details, error: "net::ERR_CONNECTION_RESET" });
        throw Error("synthetic transport failure");
      }
      ses.completed?.(details);
      ses.completed?.(details);
      ses.completed?.({ ...details, id: 99 });
      ses.completed?.({ ...details, webContentsId: 999 });
    }
  }
  let settles = 0;
  const ledger = {
    reserve: (input) => f.ledger.reserve(input),
    async settle(input) {
      if (input.verifiedUsage?.requests === 1) {
        settles++;
        await new Promise((resolve) => setImmediate(resolve));
      }
      return f.ledger.settle(input);
    },
  };
  const browser = createCollectionBrowser({
    ...fixture,
    BrowserWindow,
    ledger,
  });
  t.after(() => browser.stop());
  const read = browser.read({
    ref: c.ref,
    token: c.token,
    operationLease: c.lease,
    url: "https://m.weibo.cn/detail/123",
    routePolicy: platformPolicy("weibo"),
  });
  if (failed) await assert.rejects(read, /synthetic transport failure/);
  else await read;
  return { f, c, fixture, settles, root: await f.service.get(c.ref) };
}

test("native completion proves exactly one reserved physical request despite duplicate events", async (t) => {
  const { root, settles, fixture } = await readFixture(t);
  assert.equal(root.collectionUsage.usedRequests, 1);
  assert.equal(root.collectionUsage.knownPhysicalRequests, 1);
  assert.equal(root.collectionUsage.unknownRequestUpperBound, 0);
  assert.equal(root.collectionUsage.usedBytes, 0);
  assert.equal(settles, 1);
  assert.ok(
    [...fixture.values.values()].every(
      (ses) => ses.completed === null && ses.failed === null,
    ),
  );
});

test("redirect hops each reserve one request and final completion leaves earlier hops conservative", async (t) => {
  const { root, settles } = await readFixture(t, { redirect: true });
  assert.equal(root.collectionUsage.usedRequests, 2);
  assert.equal(root.collectionUsage.knownPhysicalRequests, 1);
  assert.equal(root.collectionUsage.unknownRequestUpperBound, 1);
  assert.equal(settles, 1);
});

test("native errors retain the request upper bound while byte accounting settles separately", async (t) => {
  const { root, settles } = await readFixture(t, { failed: true });
  assert.equal(root.collectionUsage.usedRequests, 1);
  assert.equal(root.collectionUsage.knownPhysicalRequests, 0);
  assert.equal(root.collectionUsage.unknownRequestUpperBound, 1);
  assert.equal(root.collectionUsage.usedBytes, 0);
  assert.equal(settles, 0);
});

test("the browser waits for its owned DNS resolver to drain before finishing a read",async(t)=>{
 const f=await collectionFixture(t),c=await f.openCommit();
 const fixture=collectionBrowserFixture({executeJavaScript:async()=>({html:'<div class="weibo-text">公开招聘正文</div>',selectorFound:true})});
 let startDrain,finishDrain,finished=false;
 const draining=new Promise(resolve=>{startDrain=resolve;}),release=new Promise(resolve=>{finishDrain=resolve;});
 const browser=createCollectionBrowser({...fixture,ledger:f.ledger,publicResolverFactory:({signal})=>{
  const resolver=async()=>{throw Error('synthetic resolver not used');};
  resolver.close=async()=>{assert.equal(signal.aborted,true);startDrain();await release;};
  return resolver;
 }});
 t.after(()=>browser.stop());
 const read=browser.read({ref:c.ref,token:c.token,operationLease:c.lease,url:'https://m.weibo.cn/detail/123',routePolicy:platformPolicy('weibo')}).finally(()=>{finished=true;});
 const entered=await Promise.race([draining.then(()=>true),read.then(()=>false)]);
 assert.equal(entered,true);
 assert.equal(finished,false);
 finishDrain();await read;
 assert.equal(finished,true);
});
