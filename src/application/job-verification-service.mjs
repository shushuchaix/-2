import { assertScope, assertOwned, packageError } from "../domain/packages.mjs";
import { assertCollectionWrite } from "../domain/collection.mjs";
import { selectVersionJobFact } from "../domain/job-facts.mjs";
import { ingestRecordsDraft } from "../domain/ingest-records.mjs";
import {
  prepareRecruitmentRecord,
  assessApplicationResponse,
} from "../domain/recruitment-evidence.mjs";
import { validatePublicUrl } from "../infrastructure/http/public-url.mjs";
import { loadSiteCatalog } from "../sources/catalog.mjs";
export function createJobVerificationService({
  repository,
  registry,
  activityContext,
  clock = repository.clock,
}) {
  return {
    async verifyJob({ scope, jobId, ref }) {
      const before = await repository.read(),
        pkg = assertScope(before, scope, clock.now());
      assertOwned(before, before.jobs[jobId], scope.packageId);
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
      const fact = selectVersionJobFact(before, {
        targetRevisionId: scope.targetRevisionId,
        jobId,
      });
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
          sites = loadSiteCatalog({ customSites: before.settings.customSites });
        if (provider?.fetchDetail)
          record = await provider.fetchDetail(record, {
            ...ctx,
            scope,
            runId: ctx.token.sliceRunId,
            clock,
            sites,
            config: {
              ...before.settings.sourceOverrides[provider.id],
              ...pkg.collectionSettings?.sourceOverrides[provider.id],
            },
            sessionRefs: pkg.collectionSettings?.sessionRefs || {},
          });
        const checkedAt = new Date(clock.now()).toISOString();
        if (record.applyUrl) {
          const url = validatePublicUrl(record.applyUrl).href,
            response = await ctx.request(url, {
              signal: ctx.signal,
              maxBytes: 1048576,
              maxRetries: 0,
              diagnosticContext: {
                sourceId: record.sourceId,
                endpointKind: "application",
              },
            });
          record.applicationVerification = assessApplicationResponse(
            response,
            checkedAt,
          );
        } else
          record.applicationVerification = {
            status: "unknown",
            checkedAt,
            formVerified: false,
          };
        record = prepareRecruitmentRecord(
          { ...record, retrievedAt: checkedAt },
          clock.now(),
        );
        await repository.mutateWorkspace(
          (w) => {
            ctx.signal?.throwIfAborted();
            assertScope(w, scope, clock.now());
            assertOwned(w, w.jobs[jobId], scope.packageId);
            assertCollectionWrite(w, ctx.collectionGuard);
            const result = ingestRecordsDraft(w, {
              scope,
              runId: ctx.token.sliceRunId,
              records: [record],
              observedAt: checkedAt,
              provenanceOperationId: "verify:" + ref.activityId,
            });
            if (result.jobIds[0] !== jobId)
              throw packageError(
                "verification_identity_conflict",
                "核验发现岗位身份或条件冲突，请保留原记录并单独复核。",
                409,
              );
            const application = w.applications[jobId];
            if (application)
              application.events.push({
                type: "recruitment_verified",
                at: checkedAt,
                evidence: record.recruitmentEvidence,
              });
          },
          { operationLease: ctx.operationLease },
        );
        return {
          jobId,
          recruitmentEvidence: record.recruitmentEvidence,
          checkedAt,
        };
      });
    },
  };
}
