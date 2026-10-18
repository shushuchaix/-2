import { assertScope, assertOwned, packageError } from "../domain/packages.mjs";
import { assertCollectionWrite } from "../domain/collection.mjs";
import { selectVersionJobFact } from "../domain/job-facts.mjs";
import { ingestRecordsDraft } from "../domain/ingest-records.mjs";
import { prepareRecruitmentRecord } from "../domain/recruitment-evidence.mjs";
import {
  prepareOwnedApplicationCheck,
  hasCurrentApplicationCheck,
  assessOwnedApplicationResponse,
} from "./application-verification.mjs";
import { validatePublicUrl } from "../infrastructure/http/public-url.mjs";
import { loadSiteCatalog } from "../sources/catalog.mjs";
import { randomUUID } from "node:crypto";
import { createPackageJobService } from './package-job-service.mjs';
import { readOwnedTarget } from './job-row-access.mjs';
export function createJobVerificationService({
  repository,
  registry,
  activityContext,
  clock = repository.clock,
}) {
  return {
    async verifyJob({ scope, jobId, ref }) {
      const jobs = createPackageJobService({ repository, clock });
      await readOwnedTarget(repository, scope, clock.now());
      const pkg = await repository.getRow({ collection: 'packages', id: scope.packageId }, { scope });
      const before = await jobs.getJob(jobId, scope);
      const settings = Object.fromEntries((await repository.queryRows({ collection: 'settings', ids: ['customSites', 'sourceOverrides'] })).rows.map(row => [row.id, row.value]));
      if (
        !ref ||
        ref.scope?.packageId !== scope.packageId ||
        ref.scope.targetRevisionId !== scope.targetRevisionId ||
        !activityContext
      )
        throw packageError(
          "collection_activity_required",
          "岗位核验需使用本版本采集活动的累计额度。",
          409,
        );
      const fact = before.fact;
      if (!fact.record)
        throw packageError(
          "version_fact_unavailable",
          "本版本岗位事实不存在。",
          409,
        );
      return activityContext(ref, async (ctx) => {
        ctx.signal?.throwIfAborted();
        let record = fact.record;
        const provider = registry.get(record.sourceId),
          sites = loadSiteCatalog({ customSites: settings.customSites });
        const didFetchDetail = typeof provider?.fetchDetail === "function";
        if (didFetchDetail)
          record = await provider.fetchDetail(record, {
            ...ctx,
            scope,
            runId: ctx.token.sliceRunId,
            clock,
            sites,
            config: {
              ...settings.sourceOverrides?.[provider.id],
              ...pkg.collectionSettings?.sourceOverrides[provider.id],
            },
            sessionRefs: pkg.collectionSettings?.sessionRefs || {},
          });
        const checkedAt = new Date(clock.now()).toISOString();
        const owned = prepareOwnedApplicationCheck(record, sites, clock.now());
        record = owned.record;
        const alreadyChecked =
          owned.site &&
          didFetchDetail &&
          hasCurrentApplicationCheck(record, ctx.token.sliceRunId, clock.now());
        if (!alreadyChecked && owned.check.shouldRequest) {
          const url = validatePublicUrl(owned.check.applyUrl).href,
            response = await ctx.request(url, {
              signal: ctx.signal,
              maxBytes: 1048576,
              maxRetries: 0,
              diagnosticContext: {
                sourceId: record.sourceId,
                endpointKind: "application",
              },
            });
          record.applicationVerification = assessOwnedApplicationResponse(
            owned.site,
            record,
            response,
            checkedAt,
            ctx.token.sliceRunId,
          );
        } else if (!alreadyChecked)
          record.applicationVerification = {
            status: "unknown",
            checkedAt,
            formVerified: false,
          };
        record = prepareRecruitmentRecord(
          { ...record, retrievedAt: checkedAt },
          clock.now(),
        );
        ctx.signal?.throwIfAborted();
        await jobs.ingestRecords({ scope, runId: ctx.token.sliceRunId, records: [record], observedAt: checkedAt,
          provenanceOperationId: 'verify:' + ref.activityId, expectedJobId: jobId,
          operationLease: ctx.operationLease, collectionGuard: ctx.collectionGuard,
          applicationEvent: { type: 'recruitment_verified', at: checkedAt, evidence: record.recruitmentEvidence },
        });
        return {
          jobId,
          recruitmentEvidence: record.recruitmentEvidence,
          checkedAt,
        };
      });
    },
  };
}
