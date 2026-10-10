import { randomUUID } from "node:crypto";
import { packageBusinessFixture } from "./package-business-fixture.mjs";
import { createCollectionService } from "../../src/application/collection-service.mjs";
import { createCollectionLedger } from "../../src/application/collection-ledger.mjs";
import { createCollectionRoot } from "../../src/domain/collection.mjs";
import { createSourceRegistry } from "../../src/sources/registry.mjs";
export async function collectionFixture(
  t,
  {
    providers = [],
    limits = {},
    transport,
    clock,
    modelFactory,
    evaluationService,
  } = {},
) {
  let f;
  f = await packageBusinessFixture(t, {
    clock,
    cancelPackageAndWait: (id) => f.service.cancelPackageAndWait(id),
  });
  const { a, b } = await f.twoTargets();
  f.scope = { packageId: a.packageId, targetRevisionId: a.revisionId };
  f.otherScope = { packageId: b.packageId, targetRevisionId: b.revisionId };
  f.target = a;
  f.events = [];
  f.networkCalls = 0;
  const units = providers.map((p, i) => ({
    unitId: "unit-" + i,
    sourceId: p.id,
    siteId: "site-" + i,
    queryIndex: 0,
    site: { siteId: "site-" + i, origin: "https://jobs.example.org" },
    query: { keyword: "synthetic", pageLimit: 20 },
  }));
  const wire = () => {
    f.ledger = createCollectionLedger({ repository: f.repository });
    f.service = createCollectionService({
      repository: f.repository,
      operationGate: f.operationGate,
      registry: createSourceRegistry(providers),
      modelFactory,
      evaluationService,
      ledger: f.ledger,
      planner: async () => ({
        units,
        hashes: {
          planHash: "p1",
          catalogHash: "c1",
          queryHash: "q1",
          parserVersion: "v1",
        },
        limits: {
          maxRequests: 400,
          maxDetails: 100,
          maxCostCny: 10,
          ...limits,
        },
      }),
      requestFactory:
        ({ budget, signal }) =>
        async (...args) => {
          signal?.throwIfAborted();
          await budget.claimRequest("list");
          f.networkCalls++;
          return transport
            ? transport(...args)
            : { status: 200, headers: {}, text: "{}" };
        },
      events: {
        publish: async (...args) => {
          f.events.push(args);
        },
      },
      modelConfig: {
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-flash",
      },
    });
  };
  wire();
  const reopen = f.reopen;
  f.reopen = async () => {
    await f.service.stop();
    await reopen();
    wire();
    await f.service.recover();
    return f;
  };
  t.after(() => f.service.stop().catch(() => {}));
  f.openCommit = async () => {
    const ref = { scope: f.scope, activityId: "root-" + randomUUID() },
      sliceRunId = "slice-" + randomUUID();
    const lease = await f.operationGate.acquire("collect", { scope: f.scope });
    t.after(() => lease.release().catch(() => {}));
    const token = { epoch: 0, expectedRevision: 0, sliceRunId };
    await f.repository.mutateWorkspace(
      (w) => {
        w.runs[ref.activityId] = createCollectionRoot({
          runId: ref.activityId,
          scope: f.scope,
          targetSnapshot: a,
          profileSnapshot: a.profileSnapshot,
          plan: {
            units: [
              {
                unitId: "unit",
                sourceId: "synthetic",
                siteId: "s",
                queryIndex: 0,
              },
            ],
          },
          limits: { maxRequests: 400, maxCostCny: 10, ...limits },
          now: f.clock.now(),
        });
        const p = w.runs[ref.activityId].collectionProgress;
        p.status = "collecting";
        p.activeSliceRunId = sliceRunId;
        w.runs[sliceRunId] = {
          runId: sliceRunId,
          recordId: randomUUID(),
          ownerPackageId: f.scope.packageId,
          collectionRole: "collection_slice",
          collectionActivityId: ref.activityId,
          status: "running",
          targetSnapshot: structuredClone(a),
          counts: {},
          events: [],
          lastSeq: 0,
          usage: {},
          issues: [],
        };
      },
      { operationLease: lease },
    );
    return {
      ref,
      token,
      lease,
      commit: (page, tokenOverride = token) =>
        f.service.commitCollectionPage({
          ref,
          token: tokenOverride,
          unitId: "unit",
          page,
          operationLease: lease,
        }),
    };
  };
  return f;
}
