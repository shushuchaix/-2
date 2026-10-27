import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assertInput } from '../../public/js/validation-rules.js';
import { packageError } from '../domain/packages.mjs';
import { ingestRecordsDraft, prepareIngestRecord } from '../domain/ingest-records.mjs';
import { resolveJobIdentity } from '../domain/identity.mjs';
import { resolveEvaluationFactBasis, selectVersionJobFact } from '../domain/job-facts.mjs';
import { assessRecruitmentEvidence } from '../domain/recruitment-evidence.mjs';
import { projectJobApplication } from '../domain/job-resolution.mjs';
import { jobIdentityIndexKeys, jobReadModelRecords, projectCurrentEvaluation, buildJobDuplicateStatuses, jobTitleGrams, confirmedGroupHeadId, currentDuplicateStatus, nextJobTemporalChangeAt, legacyApplicationSeedRecords } from '../domain/job-read-model.mjs';
import { identityText } from '../domain/job-identity.mjs';
import { isManualApplication } from '../domain/job-resolution.mjs';
import { contentHash } from '../infrastructure/storage/content-hash.mjs';
import { rowKey } from '../infrastructure/storage/sqlite-records.mjs';
import { jobSelector, readAllJobRows, readOwnedTarget, resolveOwnedJobId, loadJobClosure, explicitSelectors } from './job-row-access.mjs';
import { deriveLifecycle } from '../domain/lifecycle.mjs';
import { assertCollectionWrite } from '../domain/collection.mjs';
import { prepareCollectionPageCommit, applyCollectionPageCommit, collectionWriteSelectors } from './collection-page-commit.mjs';
import { sourceFactSelectors, assertSourceFactGuard } from './collection-article-recovery.mjs';
export { packageWorkspace, mergePackageWorkspace } from '../domain/package-workspace.mjs';

const stamp = (value, ownerPackageId) => ({ ...value, ownerPackageId, recordId: value.recordId || randomUUID() });
const scoped = scope => {
  if (!scope?.packageId || !scope?.targetRevisionId) throw packageError('version_scope_required', '请选择准确的目标版本。');
  return { packageId: scope.packageId, targetRevisionId: scope.targetRevisionId };
};
const descriptor = (collection, id, value, scope, extra = {}) => ({ collection, id, ownerPackageId: scope.packageId, value, ...extra });

/** Formal schema3 jobs. Ordinary reads never construct a complete package. */
export function createPackageJobService({ repository, clock = repository.clock }) {
  const at = () => new Date(clock.now()).toISOString();
  const operationMetrics = {};
  const jobHead = async (port, scope) => { const result = await port.readJobHead(scope ? { ownerPackageId: scope.packageId } : { allTargets: true }, { scope }); return JSON.stringify([result.head, result.controlDeletionHead]); };
  async function list(filters = {}, applicationPage = false, attempt = 0) {
    assertInput('filters', filters);
    const scope = filters.allTargets ? undefined : scoped(filters);
    if (scope) await readOwnedTarget(repository, scope, clock.now());
    const page = await repository[applicationPage ? 'queryApplicationPage' : 'queryJobPage'](filters, { scope, asOf: filters.asOf || at() });
    const items = [];
    for (const selected of Map.groupBy(page.items, row => row.ownerPackageId).values()) {
      const s = { packageId: selected[0].ownerPackageId, targetRevisionId: selected[0].targetRevisionId };
      const context = await readOwnedTarget(repository, s, page.asOf), ids = selected.map(row => row.jobId);
      const view = await repository.readView({ select: [
        jobSelector('jobs', s, ids), jobSelector('jobProjections', s, ids),
        jobSelector('observations', s, selected.map(row => row.currentObservationId).filter(Boolean)),
        jobSelector('evaluations', s, selected.map(row => row.evaluationId).filter(Boolean)),
        jobSelector('applications', s, selected.map(row => row.applicationId).filter(Boolean)),
      ] }, { scope: s });
      for (const selectedRow of selected) {
        const job = view.rows.jobs[selectedRow.jobId], p = view.rows.jobProjections[selectedRow.jobId];
        if (!job || !p || p.currentObservationId !== selectedRow.currentObservationId || p.evaluationId !== selectedRow.evaluationId || p.applicationId !== selectedRow.applicationId) {
          if (attempt < 2) return list({ ...filters, asOf: page.asOf }, applicationPage, attempt + 1);
          throw packageError('job_read_model_changed', '岗位索引正在变化，请重新读取。');
        }
        const observation = view.rows.observations?.[p.currentObservationId], record = observation?.fields || observation?.record || { title: job.canonical.title, company: job.canonical.company, kind: job.kind, cities: [] };
        const evaluation = projectCurrentEvaluation(view.rows.evaluations?.[p.evaluationId], record, context.target.profileSnapshot.profile, page.asOf, context.target);
        const application = view.rows.applications?.[p.applicationId] || { jobId: job.jobId, status: 'new', note: '', resumeRevisionId: null, appliedAt: null, followUpAt: null, events: [] };
        const meta = { ownerPackageId: s.packageId, packageId: s.packageId, targetRevisionId: s.targetRevisionId, versionName: context.pkg.versionName, scope: s };
        items.push(applicationPage ? { ...application, application: { ...application }, job, canonical: record, title: record.title || '', company: record.company || '', ...meta } : {
          job, ...record, jobId: job.jobId,
          fact: { status: observation ? 'verified' : 'missing', record: observation ? record : null, factContentHash: p.factContentHash, observationIds: p.observationIds || [], originalJobId: observation?.jobId || null },
          application, evaluation, duplicateStatus: selectedRow.duplicateStatus,
          recruitmentEvidence: assessRecruitmentEvidence({ record, now: Date.parse(page.asOf) }),
          asOf: page.asOf, nextTemporalChangeAt: selectedRow.nextTemporalChangeAt, ...meta,
        });
      }
    }
    const order = new Map(page.items.map((row, index) => [row.jobId, index]));
    items.sort((a, b) => order.get(a.jobId) - order.get(b.jobId));
    if (await jobHead(repository, scope) !== JSON.stringify([page.jobHead, page.controlDeletionHead])) {
      if (attempt < 2) return list({ ...filters, asOf: page.asOf }, applicationPage, attempt + 1);
      throw packageError('job_read_model_changed', '岗位索引正在变化，请重新读取。');
    }
    return { ...page, items };
  }
  async function applicationProjectionWorkspace(port, workspace, scope) {
    const ids = Object.keys(workspace.applications), applications = {}, projections = { ...workspace.jobProjections };
    const identityOverlay=Object.values(workspace.jobs).map(job=>({jobId:job.jobId,aliases:job.identityAliases||[]}));
    for (let offset = 0; offset < ids.length; offset += 200) {
      const page = await port.queryLegacyApplicationPage({ ...scope, applicationIds: ids.slice(offset, offset + 200), includeResolved: true, pageSize: 200 }, { scope, identityOverlay });
      for (const selected of page.items) {
        const application = workspace.applications[selected.applicationId];
        if (isManualApplication(application)) for (const id of selected.association.jobIds) projections[id] = { ...projections[id], manualApplication: true };
        if (selected.association.status === 'single') {
          const jobId = selected.association.jobIds[0];
          applications[application.applicationId] = { ...application, jobId, ...(application.legacyJobIds ? { legacyJobIds: [jobId] } : {}) };
        }
      }
    }
    // A newly created application has not reached SQL yet; its explicit jobId
    // was resolved by this command and is already in the declared owner closure.
    for (const id of ids) if (!applications[id] && !workspace.applications[id].legacyJobIds && workspace.jobs[workspace.applications[id].jobId]) {
      const existing = await port.getRow({ collection: 'applications', id, ownerPackageId: scope.packageId }, { scope });
      if (!existing) applications[id] = workspace.applications[id];
    }
    return { ...workspace, applications, jobProjections: projections };
  }
  async function expandLegacyApplications(port, scope, closed, changed) {
    const overlay=changed.map(id=>closed.workspace.jobs[id]).filter(Boolean).map(job=>({jobId:job.jobId,aliases:job.identityAliases||[]}));
    const seeds=[...new Set(overlay.flatMap(job=>[job.jobId,...job.aliases]))], ids=new Set();
    for(let offset=0;offset<Math.max(1,seeds.length);offset+=1000){
      let afterId;
      do{
        const page=await port.findLegacyApplicationIds({ownerPackageId:scope.packageId,jobIds:seeds.slice(offset,offset+1000),limit:200,...(afterId?{afterId}:{})},{scope});
        page.applicationIds.forEach(id=>ids.add(id));afterId=page.hasMore?page.nextCursor:null;
      }while(afterId);
    }
    const affected=new Set(changed),allIds=[...ids];
    for(let offset=0;offset<allIds.length;offset+=200){
      const batch=allIds.slice(offset,offset+200),before=await port.queryLegacyApplicationPage({...scope,applicationIds:batch,includeResolved:true,pageSize:200},{scope}),after=await port.queryLegacyApplicationPage({...scope,applicationIds:batch,includeResolved:true,pageSize:200},{scope,identityOverlay:overlay});
      for(const item of [...before.items,...after.items])item.association.jobIds.forEach(id=>affected.add(id));
      const apps=await port.queryRows(jobSelector('applications',scope,batch),{scope});
      closed.rows.applications||={};
      for(const row of apps.rows){closed.rows.applications[row.id]=row.value;closed.workspace.applications[row.id]=row.value;closed.records.push({collection:'applications',...row});}
    }
    const extra=[...affected].filter(id=>!closed.workspace.jobs[id]);
    if(extra.length){
      const more=await loadJobClosure(port,scope,extra,{includeIdentity:true});
      for(const [collection,rows]of Object.entries(more.rows)){closed.rows[collection]||={};for(const [id,value]of Object.entries(rows))if(!Object.hasOwn(closed.rows[collection],id))closed.rows[collection][id]=value;}
      for(const collection of ['jobs','observations','evaluations','applications','jobProjections','jobRelations'])for(const [id,value]of Object.entries(more.workspace[collection]))if(!Object.hasOwn(closed.workspace[collection],id))closed.workspace[collection][id]=value;
      Object.assign(closed.workspace.targetMembers[scope.targetRevisionId],more.workspace.targetMembers[scope.targetRevisionId]);
      for(const [alias,jobIds]of Object.entries(more.workspace.identityAliases))closed.workspace.identityAliases[alias]=[...new Set([...(closed.workspace.identityAliases[alias]||[]),...jobIds])];
      closed.records.push(...more.records);
    }
    return [...affected];
  }
  async function prepareWrites(scope, closed, records, jobIds, { collectionGuard, collectionPage, sourceFactGuard, recomputeDuplicates = false, measurements, port = repository } = {}) {
    const projectionStart = performance.now();
    const groupUpdates = new Map(), memberUpdates = [];
    for (const [id, previous] of Object.entries(closed.rows.jobRelations || {})) {
      if (previous.kind !== 'confirmed_group_member' || !jobIds.includes(previous.jobId)) continue;
      const headId = confirmedGroupHeadId(previous.groupId), head = groupUpdates.get(headId) || structuredClone(closed.workspace.jobRelations[headId]);
      if (!head) throw packageError('job_read_model_unavailable', '重复组摘要尚未就绪。');
      const member = closed.workspace.jobRelations[id], oldManual = previous.manualApplicationCount;
      if (member) {
        const manual = Math.max(oldManual, Object.values(closed.workspace.applications).filter(application => application.jobId === previous.jobId && isManualApplication(application)).length);
        if (manual !== oldManual) { member.manualApplicationCount = manual; head.manualApplicationCount += manual - oldManual; memberUpdates.push(descriptor('jobRelations', id, member, scope, { jobId: member.jobId })); }
      } else { head.memberCount--; head.manualApplicationCount -= oldManual; }
      head.status = head.memberCount < 2 ? 'normal' : head.manualApplicationCount > 1 ? 'protected' : 'possible';
      groupUpdates.set(headId, head);
    }
    if (recomputeDuplicates) {
      const relations = Object.values(closed.workspace.jobRelations);
      closed.workspace.duplicateStatuses = buildJobDuplicateStatuses(closed.workspace, { relations });
      const memberIds = relations.filter(row => row.kind === 'confirmed_group_member').map(row => row.jobId);
      if (memberIds.length) {
        const pairStatuses = buildJobDuplicateStatuses(closed.workspace, { relations: relations.filter(row => row.kind !== 'confirmed_group_member' && row.kind !== 'confirmed_group_head') });
        for (const id of memberIds) closed.workspace.duplicateStatuses.set(id, pairStatuses.get(id) || 'normal');
      }
    }
    const projectionWorkspace = await applicationProjectionWorkspace(port, closed.workspace, scope);
    // Historical global aliases remain authoritative after application writes.
    // Extend only the projection overlay; publishing a score/status must not
    // rewrite the stored job's canonical facts or inline identity history.
    const aliasesByJob = new Map();
    for (const [alias, ids] of Object.entries(closed.workspace.identityAliases)) for (const id of ids) {
      const aliases = aliasesByJob.get(id) || [];
      aliases.push(alias); aliasesByJob.set(id, aliases);
    }
    projectionWorkspace.jobs = Object.fromEntries(Object.entries(projectionWorkspace.jobs).map(([id, job]) => [id,
      { ...job, identityAliases: [...new Set([...(job.identityAliases || []), ...(aliasesByJob.get(id) || [])])] },
    ]));
    const derived = jobIds.flatMap(jobId => jobReadModelRecords(projectionWorkspace, { jobId, targetRevisionId: scope.targetRevisionId, asOf: clock.now() }));
    const desiredKeys = new Set(derived.filter(row => row.collection === 'jobIdentityKeys').map(row => row.id));
    const removed = closed.records.filter(row => row.collection === 'jobIdentityKeys' && jobIds.includes(row.value.jobId) && !desiredKeys.has(row.id)).map(row => ({ ...row, ownerPackageId: scope.packageId }));
    const seeds=records.filter(record=>record.collection==='applications'&&!record.remove).flatMap(record=>legacyApplicationSeedRecords(record.value));
    const all = [...records, ...derived, ...seeds, ...memberUpdates, ...[...groupUpdates].map(([id, head]) => descriptor('jobRelations', id, head, scope, { jobId: head.jobId })), ...(collectionPage?.records || [])], guardId = collectionGuard?.ref?.activityId;
    if (measurements) measurements.projectionMs = performance.now() - projectionStart;
    return { all, removed, guardId, collectionPage, selection: { select: [...collectionWriteSelectors([...all, ...removed, ...(guardId ? [{ collection: 'runs', id: guardId, ownerPackageId: scope.packageId }] : [])]), ...(collectionPage?.select || []), ...sourceFactSelectors(scope, sourceFactGuard)] } };
  }
  async function persist(fence, scope, closed, records, jobIds, options = {}) {
    const { collectionGuard, result, signal, measurements } = options;
    const { all, removed, guardId, collectionPage, selection } = options.prepared || await prepareWrites(scope, closed, records, jobIds, { ...options, port: fence });
    const transactionStart = performance.now();
    const receipt = fence.transaction(selection, tx => {
      signal?.throwIfAborted();
      if (options.sourceFactGuard) assertSourceFactGuard(tx.view, scope, options.sourceFactGuard);
      if (guardId) {
        const root = tx.getRow({ collection: 'runs', id: guardId });
        const targetRevisionId = tx.view.indexes.runs?.[guardId]?.targetRevisionId;
        assertCollectionWrite({ runs: { [guardId]: { ...root, targetSnapshot: { revisionId: targetRevisionId } } } }, collectionGuard);
      }
      if (collectionPage) applyCollectionPageCommit(tx, collectionPage);
      for (const row of removed) tx.deleteRow({ collection: row.collection, id: row.id, ownerPackageId: scope.packageId });
      for (const row of all) { if (row.remove) tx.deleteRow({ collection: row.collection, id: row.id, ownerPackageId: scope.packageId }); else tx.putRow(row); }
      return collectionPage ? { ...result, collectionPage: collectionPage.result } : result;
    });
    if (measurements) measurements.transactionMs = performance.now() - transactionStart;
    return receipt.result;
  }
  async function ingest(input) {
    const started = performance.now(), measurements = { recordCount: input.records?.length || 0, normalizationMs: 0, signatureLookupMs: 0, identityBuildMs: 0, candidateSqlMs: 0 };
    const scope = scoped(input.scope), observedAt = input.observedAt || at();
    if (input.collectionPageCommit) {
      const guard = { ref: input.collectionPageCommit.ref, token: input.collectionPageCommit.token };
      if (input.collectionGuard && contentHash(input.collectionGuard) !== contentHash(guard)) throw packageError('collection_scope', '页面提交与采集权限范围不一致。');
      input = { ...input, collectionGuard: guard };
    }
    if (input.sourceFactGuard) assertSourceFactGuard(await repository.readView({
      select: sourceFactSelectors(scope, input.sourceFactGuard),
    }, { scope }), scope, input.sourceFactGuard);
    if (!Array.isArray(input.records) || input.records.length > 1000) throw packageError('invalid_job_records', '每批最多接收1000条岗位证据。', 400);
    const normalizedRecords = input.records.map(record => {
      const normalizationStart = performance.now(), normalized = prepareIngestRecord(record, { observedAt });
      measurements.normalizationMs += performance.now() - normalizationStart; return normalized;
    }), identitySignatures = new Map();
    for (let attempt = 0; attempt < 3; attempt++) {
      measurements.attempts = attempt + 1;
      const preparationStarted = performance.now(), baseHead = await jobHead(repository, scope);
      input.signal?.throwIfAborted();
      const run = await repository.getRow({ collection: 'runs', id: input.runId, ownerPackageId: scope.packageId }, { scope });
      if (!run) throw packageError('package_scope_mismatch', '采集运行不属于此目标版本。');
      const missingHashes = [...new Set(normalizedRecords.filter(record => String(record.description || '').trim().length >= 30).map(record => contentHash(record.description)))].filter(hash => !identitySignatures.has(hash));
      if (missingHashes.length) {
        const signatureLookupStart = performance.now();
        const retained = await repository.readJobBodySignatures({ ownerPackageId: scope.packageId, contentHashes: missingHashes }, { scope });
        for (const signature of retained.signatures) identitySignatures.set(signature.contentHash, signature);
        measurements.signatureLookupMs += performance.now() - signatureLookupStart;
      }
      const candidates = new Set(), candidateJobIdsByRecord = [], candidateRecordIndexesByRecord = [], priorKeys = new Map();
      for (const [recordIndex, record] of input.records.entries()) {
        input.signal?.throwIfAborted();
        const normalized = normalizedRecords[recordIndex];
        const identityStart = performance.now();
        const keys = jobIdentityIndexKeys(normalized, [record.id].filter(Boolean), { signatureCache: identitySignatures }), recordCandidates = new Set(), previousRecords = new Set();
        measurements.identityBuildMs += performance.now() - identityStart;
        const identityTitle = identityText(normalized.title), titleGrams = jobTitleGrams(identityTitle), recordIdentity = { company: identityText(normalized.company), title: identityTitle, titleGrams, titleGramCount: titleGrams.length };
        for (let keyOffset = 0; keyOffset < keys.length; keyOffset += 4096) {
          let afterJobId = '';
          do {
            const sqlStarted = performance.now();
            const page = await repository.findJobIdentityCandidates({ ownerPackageId: scope.packageId, keys: keys.slice(keyOffset, keyOffset + 4096), ...(keys.length <= 4096 ? { recordIdentity } : {}), afterJobId, limit: 200 }, { scope });
            measurements.candidateSqlMs += performance.now() - sqlStarted;
            page.jobIds.forEach(id => { candidates.add(id); recordCandidates.add(id); }); if (!page.hasMore) break; afterJobId = page.nextCursor;
          } while (afterJobId);
        }
        for (const key of keys) {
          const identityKey = JSON.stringify([key.kind, key.resourceKey]);
          for (const previous of priorKeys.get(identityKey) || []) previousRecords.add(previous);
          (priorKeys.get(identityKey) || (priorKeys.set(identityKey, []), priorKeys.get(identityKey))).push(recordIndex);
        }
        candidateJobIdsByRecord.push([...recordCandidates]); candidateRecordIndexesByRecord.push([...previousRecords]);
        candidates.add('j-' + contentHash([scope.packageId, resolveJobIdentity(normalized).key]).slice(0, 24));
      }
      measurements.candidateJobCount = candidates.size;
      const closureStart = performance.now();
      const closed = await loadJobClosure(repository, scope, [...candidates], { includeIdentity: true }), w = closed.workspace;
      measurements.closureReadMs = performance.now() - closureStart; measurements.closureRecordCount = closed.records.length;
      w.identitySignatures = identitySignatures;
      w.runs[input.runId] = { ...run, targetSnapshot: closed.target };
      const oldGroups = new Set(Object.keys(w.duplicateGroups)), oldGroupIds = new Map(Object.values(w.jobs).map(job => [job.jobId, JSON.stringify(job.duplicateGroupIds || [])]));
      const draftStart = performance.now();
      const result = ingestRecordsDraft(w, { ...input, scope, observedAt, targetRevisionId: scope.targetRevisionId, candidateJobIdsByRecord, candidateRecordIndexesByRecord, normalizedRecords });
      measurements.factDraftMs = performance.now() - draftStart;
      const assemblyStart = performance.now();
      w.duplicateStatuses = new Map(Object.values(w.jobProjections).map(row => [row.jobId, row.duplicateStatus]));
      if (input.expectedJobId && (result.jobIds.length !== 1 || result.jobIds[0] !== input.expectedJobId)) throw packageError('verification_identity_conflict', '核验发现岗位身份或条件冲突，请保留原记录并单独复核。');
      const changed = [...new Set([...result.jobIds, ...Object.values(w.jobs).filter(job => oldGroupIds.get(job.jobId) !== JSON.stringify(job.duplicateGroupIds || [])).map(job => job.jobId)])], records = [];
      // A prior confirmed clique remains valid for its unchanged members. New
      // facts are classified independently; remove a changed member's old proof.
      for (const [relationId, relation] of Object.entries(w.jobRelations)) if (relation.kind === 'confirmed_group_member' && changed.includes(relation.jobId) && contentHash(w.jobs[relation.jobId].canonical) !== contentHash(closed.rows.jobs[relation.jobId]?.canonical)) {
        delete w.jobRelations[relationId]; records.push({ collection: 'jobRelations', id: relationId, ownerPackageId: scope.packageId, remove: true });
      }
      for (const relation of result.duplicateRelations) {
        const affectsProjection = relation.relation !== 'distinct' || !!w.jobRelations[rowKey(relation.jobId, relation.otherJobId)];
        if (affectsProjection) for (const id of [relation.jobId, relation.otherJobId]) if (!changed.includes(id)) changed.push(id);
        for (const [jobId, otherJobId] of [[relation.jobId, relation.otherJobId], [relation.otherJobId, relation.jobId]]) {
          const id = rowKey(jobId, otherJobId), value = { jobId, otherJobId, ownerPackageId: scope.packageId, relation: relation.relation, reasonCodes: relation.reasonCodes };
          if (relation.relation === 'distinct') { if (w.jobRelations[id]) { delete w.jobRelations[id]; records.push({ collection: 'jobRelations', id, ownerPackageId: scope.packageId, remove: true }); } }
          else { w.jobRelations[id] = value; records.push(descriptor('jobRelations', id, value, scope, { jobId })); }
        }
      }
      for (const id of changed) {
        w.jobs[id] = stamp(w.jobs[id], scope.packageId);
        w.jobs[id].identityAliases = [...new Set([...w.jobs[id].identityAliases, ...Object.entries(w.identityAliases).filter(([, ids]) => ids.includes(id)).map(([alias]) => alias)])];
        records.push(descriptor('jobs', id, w.jobs[id], scope));
      }
      for (const row of Object.values(w.observations).filter(row => !closed.rows.observations?.[row.observationId])) {
        w.observations[row.observationId] = stamp(row, scope.packageId); records.push(descriptor('observations', row.observationId, w.observations[row.observationId], scope));
      }
      records.push(descriptor('memberGroups', scope.targetRevisionId, {}, scope, { targetRevisionId: scope.targetRevisionId }));
      for (const id of [...new Set(result.jobIds)]) records.push(descriptor('targetMembers', rowKey(scope.targetRevisionId, id), w.targetMembers[scope.targetRevisionId][id], scope, { jobId: id, targetRevisionId: scope.targetRevisionId, parent: { collection: 'memberGroups', id: scope.targetRevisionId, path: 'targetMembers' } }));
      for (const [id, value] of Object.entries(w.duplicateGroups)) if (!oldGroups.has(id)) records.push(descriptor('duplicateGroups', id, { ...value, ownerPackageId: scope.packageId }, scope));
      if (input.applicationEvent) {
        const application = Object.values(w.applications).find(a => a.jobId === result.jobIds[0]);
        if (application) {
          const maximum = await repository.aggregateRows({ collection: 'applicationEvents', ownerPackageId: scope.packageId, where: { parentId: application.applicationId }, operation: 'max', field: 'ordinal' }, { scope });
          const ordinal = maximum.groups[0]?.value == null ? 0 : maximum.groups[0].value + 1;
          records.push(descriptor('applicationEvents', rowKey(application.applicationId, 'events', String(ordinal)), stamp(input.applicationEvent, scope.packageId), scope, { ordinal, parent: { collection: 'applications', id: application.applicationId, path: 'events' } }));
          application.manualHistory = true; records.push(descriptor('applications', application.applicationId, application, scope));
        }
      }
      measurements.recordAssemblyMs = performance.now() - assemblyStart;
      const affectedApplicationJobs=await expandLegacyApplications(repository,scope,closed,changed);
      for(const id of affectedApplicationJobs)if(!changed.includes(id))changed.push(id);
      const collectionPage = input.collectionPageCommit ? await prepareCollectionPageCommit(repository, { ...input.collectionPageCommit, scope, ingestResult: result }) : null;
      const prepared = await prepareWrites(scope, closed, records, changed, { ...input, collectionPage, recomputeDuplicates: true, measurements });
      measurements.preparationMs = performance.now() - preparationStarted;
      const fenceRequested = performance.now();
      try {
        const outcome = await repository.withWriteFence(async fence => {
          const fenceStarted = performance.now(); measurements.fenceWaitMs = fenceStarted - fenceRequested;
          input.signal?.throwIfAborted();
          if (await jobHead(fence, scope) !== baseHead) throw packageError('job_write_conflict', '岗位准备期间数据已变化，请重试。');
          const committedResult = await persist(fence, scope, closed, records, changed, { ...input, result, measurements, prepared });
          measurements.fenceDurationMs = performance.now() - fenceStarted;
          return committedResult;
        }, { scope, operationLease: input.operationLease });
        measurements.totalMs = performance.now() - started; operationMetrics.ingest = measurements;
        return outcome;
      } catch (error) { if (['job_write_conflict', 'collection_queue_conflict'].includes(error.code) && attempt < 2) continue; throw error; }
    }
  }
  async function saveEvaluations(evaluations, selectedScope, options = {}) {
    const scope = scoped(selectedScope);
    if (!Array.isArray(evaluations) || evaluations.length > 1000) throw packageError('invalid_evaluation_batch', '评价必须分批保存。', 400);
    return repository.withWriteFence(async fence => {
      options.signal?.throwIfAborted();
      const ids = [...new Set(evaluations.map(e => e.jobId))], closed = await loadJobClosure(fence, scope, ids, { includeIdentity: true }), w = closed.workspace, records = [];
      for (const input of evaluations) {
        if (!w.jobs[input.jobId] || !input.evaluationId || input.targetRevisionId !== scope.targetRevisionId || input.profileRevisionId !== closed.target.profileSnapshot.revisionId) throw packageError('package_scope_mismatch', '评价的岗位、目标或自有简历副本不一致。');
        const current = w.evaluations[input.evaluationId];
        if (current && contentHash({ ...current, recordId: undefined, ownerPackageId: undefined }) !== contentHash({ ...input, recordId: undefined, ownerPackageId: undefined })) throw Error('Evaluation immutable');
        const value = stamp({ ...input, ...(current ? { recordId: current.recordId } : {}) }, scope.packageId);
        w.evaluations[value.evaluationId] = value; records.push(descriptor('evaluations', value.evaluationId, value, scope));
      }
      return persist(fence, scope, closed, records, ids, { ...options, result: evaluations });
    }, { scope, operationLease: options.operationLease });
  }
  async function getJob(requestedJobId, selectedScope, attempt = 0, asOf = at()) {
    const scope = scoped(selectedScope), startHead = await jobHead(repository, scope);
    const id = await resolveOwnedJobId(repository, scope, requestedJobId), closed = await loadJobClosure(repository, scope, [id], { includeHistory: false }), w = closed.workspace;
    const projection = w.jobProjections[id];
    if (!projection) throw packageError('job_read_model_unavailable', '岗位索引尚未就绪。');
    const observationsPage = await repository.queryRows(jobSelector('observations', scope, null, { where: { jobId: id }, limit: 50, ...(selectedScope.observationCursor ? { afterId: selectedScope.observationCursor } : {}), total: true }), { scope });
    const evaluationsPage = await repository.queryRows(jobSelector('evaluations', scope, null, { where: { jobId: id }, limit: 50, ...(selectedScope.evaluationCursor ? { afterId: selectedScope.evaluationCursor } : {}), total: true }), { scope });
    const current = await repository.readView({ select: [
      jobSelector('observations', scope, [projection.currentObservationId].filter(Boolean)),
      jobSelector('evaluations', scope, [projection.evaluationId].filter(Boolean)),
      jobSelector('applications', scope, [projection.applicationId].filter(Boolean)),
      jobSelector('jobFactBasis', scope, evaluationsPage.rows.map(row => row.value.observationId).filter(Boolean)),
    ] }, { scope });
    Object.assign(w.observations, current.rows.observations || {}); Object.assign(w.evaluations, current.rows.evaluations || {}); Object.assign(w.applications, current.rows.applications || {});
    const fact = selectVersionJobFact(w, { jobId: id, targetRevisionId: scope.targetRevisionId }); fact.observationIds = projection.observationIds || [];
    const job = w.jobs[id];
    const evaluation = projectCurrentEvaluation(w.evaluations[projection.evaluationId], fact.record || job.canonical, closed.target.profileSnapshot.profile, asOf, closed.target);
    const compactId = projection.confirmedDuplicateGroupId, head = compactId ? await repository.getRow({ collection: 'jobRelations', id: confirmedGroupHeadId(compactId), ownerPackageId: scope.packageId }, { scope }) : null;
    if (compactId && !head) throw packageError('job_read_model_unavailable', '重复组摘要尚未就绪。');
    const relatedPage = await repository.queryJobRelatedPage({ ownerPackageId: scope.packageId, jobId: id, ...(selectedScope.relatedJobCursor ? { afterJobId: selectedScope.relatedJobCursor } : {}), limit: 50 }, { scope });
    const relatedIds = relatedPage.jobIds;
    const related = relatedIds.length ? await repository.queryRows(jobSelector('jobs', scope, relatedIds), { scope }) : { rows: [] };
    const rawApplication = w.applications[projection.applicationId];
    if (rawApplication) w.applications[projection.applicationId] = { ...rawApplication, jobId: id, ...(rawApplication.legacyJobIds ? { legacyJobIds: [id] } : {}) };
    const application = projectJobApplication(w, id);
    if (rawApplication) application.originalApplicationId = rawApplication.jobId;
    let applicationEvents = { rows: [], total: 0, hasMore: false, nextCursor: null };
    if (application.applicationId) applicationEvents = await repository.queryRows(jobSelector('applicationEvents', scope, null, { where: { parentId: application.applicationId }, limit: 50, ...(selectedScope.applicationEventCursor ? { afterId: selectedScope.applicationEventCursor } : {}) }), { scope });
    application.events = applicationEvents.rows.map(row => row.value);
    const unresolved = await unresolvedPage({ ...scope, jobId: id, pageSize: 50 }, 0, true);
    if (await jobHead(repository, scope) !== startHead) {
      if (attempt < 2) return getJob(requestedJobId, selectedScope, attempt + 1, asOf);
      throw packageError('job_read_model_changed', '岗位索引正在变化，请重新读取。');
    }
    return { job: { ...job, canonical: fact.record || { title: job.canonical.title, company: job.canonical.company, kind: job.kind, cities: [] } }, jobId: id, requestedJobId, fact, targetRevisionId: scope.targetRevisionId, ownerPackageId: scope.packageId, packageId: scope.packageId,
      recruitmentEvidence: assessRecruitmentEvidence({ record: fact.record || job.canonical, now: Date.parse(asOf) }), evaluation,
      observations: observationsPage.rows.map(row => row.value), evaluations: evaluationsPage.rows.map(({ value: e }) => ({ ...e, factBasis: current.rows.jobFactBasis?.[e.observationId]?.factContentHash === e.factContentHash ? { status: 'verified', factContentHash: e.factContentHash, observationIds: [e.observationId], reasonCode: 'verified_observation' } : { status: 'historical', factContentHash: null, observationIds: [], reasonCode: 'unverified_fact_basis' }, matchesCurrentFact: e.evaluationId === evaluation?.evaluationId })),
      history: { observations: { total: observationsPage.total, hasMore: observationsPage.hasMore, nextCursor: observationsPage.nextCursor }, evaluations: { total: evaluationsPage.total, hasMore: evaluationsPage.hasMore, nextCursor: evaluationsPage.nextCursor }, applicationEvents: { total: applicationEvents.total, hasMore: applicationEvents.hasMore, nextCursor: applicationEvents.nextCursor } },
      application, duplicateStatus: currentDuplicateStatus(projection, head), relatedJobs: related.rows.map(row => row.value), relatedJobsPage: { total: relatedPage.total, hasMore: relatedPage.hasMore, nextCursor: relatedPage.nextCursor },
      unresolvedApplications: unresolved.items.map(item => item.application), unresolvedApplicationsPage: { total: unresolved.total, hasMore: unresolved.hasMore, page: unresolved.page, pageSize: unresolved.pageSize }, asOf, nextTemporalChangeAt: evaluation?.nextTemporalChangeAt || nextJobTemporalChangeAt(fact.record || job.canonical, closed.target.profileSnapshot.profile, asOf) };
  }
  async function applicationItem(selected, selectedScope) {
    const scope = { packageId: selected.ownerPackageId, targetRevisionId: selected.targetRevisionId };
    const application = await repository.getRow({ collection: 'applications', id: selected.applicationId, ownerPackageId: scope.packageId }, { scope });
    if (!application) throw packageError('job_read_model_changed', '投递记录正在变化，请重新读取。');
    const events = await repository.queryRows(jobSelector('applicationEvents', scope, null, { where: { parentId: application.applicationId }, limit: 50, total: true, ...(selectedScope?.applicationEventCursor ? { afterId: selectedScope.applicationEventCursor } : {}) }), { scope });
    application.events = events.rows.map(row => row.value);
    const candidateJobs = [];
    for (let offset = 0; offset < selected.association.jobIds.length; offset += 200) {
      const jobs = await repository.queryRows(jobSelector('jobs', scope, selected.association.jobIds.slice(offset, offset + 200)), { scope });
      candidateJobs.push(...jobs.rows.map(row => row.value));
    }
    return { application: selected.association.status === 'single' ? { ...application, jobId: selected.association.jobIds[0], originalApplicationId: application.jobId } : application,
      association: selected.association, candidateJobs, unresolved: selected.association.status !== 'single', history: { events: { total: events.total, hasMore: events.hasMore, nextCursor: events.nextCursor } },
      ownerPackageId: scope.packageId, packageId: scope.packageId, targetRevisionId: scope.targetRevisionId, scope };
  }
  async function unresolvedPage(filters, attempt = 0, coveredHead = false) {
    const scope = filters.allTargets ? undefined : scoped(filters);
    // The fixed page validates scope/control even for no matches. getJob already
    // owns the surrounding job head; do not reload its profile or repeat heads.
    const startHead = coveredHead ? null : await jobHead(repository, scope), page = await repository.queryLegacyApplicationPage(filters, { scope });
    const items = [];
    for (const selected of page.items) items.push(await applicationItem(selected, filters));
    if (!coveredHead && await jobHead(repository, scope) !== startHead) {
      if (attempt < 2) return unresolvedPage(filters, attempt + 1);
      throw packageError('job_read_model_changed', '投递记录正在变化，请重新读取。');
    }
    return { ...page, items };
  }
  async function getApplication(id, selectedScope, attempt = 0) {
    const scope = scoped(selectedScope), startHead = await jobHead(repository, scope); await readOwnedTarget(repository, scope, clock.now());
    const page = await repository.queryLegacyApplicationPage({ ...scope, applicationIds: [id], includeResolved: true }, { scope });
    if (!page.items.length) throw packageError('package_scope_mismatch', '投递记录不存在于所选目标版本。');
    const result = await applicationItem(page.items[0], selectedScope);
    if (await jobHead(repository, scope) !== startHead) {
      if (attempt < 2) return getApplication(id, selectedScope, attempt + 1);
      throw packageError('job_read_model_changed', '投递记录正在变化，请重新读取。');
    }
    return result;
  }
  async function updateUnresolved(fence, application, association, patch, scope) {
    const context = await readOwnedTarget(fence, scope, clock.now());
    if (patch.resumeRevisionId != null && patch.resumeRevisionId !== context.target.profileSnapshot.revisionId) throw packageError('package_scope_mismatch', '投递简历只能使用本目标自有简历副本。');
    const changes = {};
    for (const field of ['status', 'note', 'resumeRevisionId', 'appliedAt', 'followUpAt']) if (Object.hasOwn(patch, field) && application[field] !== patch[field]) { changes[field] = { from: application[field] ?? null, to: patch[field] }; application[field] = patch[field]; }
    const records = [descriptor('applications', application.applicationId, application, scope)];
    const prior = fence.queryRows(jobSelector('applicationEvents', scope, null, { where: { parentId: application.applicationId }, limit: 50, total: true }));
    if (Object.keys(changes).length) {
      application.manualHistory = true;
      const maximum = fence.aggregateRows({ collection: 'applicationEvents', ownerPackageId: scope.packageId, where: { parentId: application.applicationId }, operation: 'max', field: 'ordinal' });
      const ordinal = maximum.groups[0]?.value == null ? 0 : maximum.groups[0].value + 1;
      const event = stamp({ type: 'application_updated', at: at(), changes }, scope.packageId);
      records.push(descriptor('applicationEvents', rowKey(application.applicationId, 'events', String(ordinal)), event, scope, { ordinal, parent: { collection: 'applications', id: application.applicationId, path: 'events' } }));
    }
    fence.transaction({ select: explicitSelectors(scope, [], records) }, tx => { for (const record of records) tx.putRow(record); });
    return { ...application, events: [...prior.rows.map(row => row.value), ...records.filter(row => row.collection === 'applicationEvents').map(row => row.value)], eventsPage: { total: prior.total + Number(records.length > 1), hasMore: prior.hasMore, nextCursor: prior.nextCursor }, originalApplicationId: application.jobId, association };
  }
  async function updateApplication(id, patch, selectedScope, byJob) {
    const scope = scoped(selectedScope); assertInput('application', patch);
    return repository.withWriteFence(async fence => {
      const selectedApplication = byJob ? null : fence.getRow({ collection: 'applications', id, ownerPackageId: scope.packageId });
      const association = selectedApplication ? fence.queryLegacyApplicationPage({ ...scope, applicationIds: [id], includeResolved: true }, { scope }).items[0]?.association : null;
      if (selectedApplication && association?.status !== 'single') return updateUnresolved(fence, selectedApplication, association, patch, scope);
      const jobId = byJob ? await resolveOwnedJobId(fence, scope, id) : association?.jobIds[0];
      if (!jobId) throw packageError('application_not_found', '投递记录不存在。', 404);
      const closed = await loadJobClosure(fence, scope, [jobId], { includeIdentity: true }), w = closed.workspace;
      const relatedIds = [...new Set(Object.values(w.jobRelations).filter(relation => ['confirmed', 'possible'].includes(relation.relation)).map(relation => relation.otherJobId))].filter(other => other !== jobId);
      if (relatedIds.length) {
        const related = await loadJobClosure(fence, scope, relatedIds, { includeIdentity: true });
        for (const collection of ['jobs', 'observations', 'evaluations', 'applications', 'jobProjections', 'jobRelations']) Object.assign(w[collection], related.workspace[collection]);
        Object.assign(w.targetMembers[scope.targetRevisionId], related.workspace.targetMembers[scope.targetRevisionId]);
        closed.records.push(...related.records);
      }
      let application = selectedApplication || Object.values(w.applications).find(a => a.jobId === jobId);
      if (!application && w.jobProjections[jobId]?.applicationId) application = fence.getRow({ collection: 'applications', id: w.jobProjections[jobId].applicationId, ownerPackageId: scope.packageId });
      application ||= stamp({ applicationId: 'a-' + randomUUID(), jobId, status: 'new', note: '', resumeRevisionId: null, appliedAt: null, followUpAt: null }, scope.packageId);
      if (patch.resumeRevisionId != null && patch.resumeRevisionId !== closed.target.profileSnapshot.revisionId) throw packageError('package_scope_mismatch', '投递简历只能使用本目标自有简历副本。');
      const changes = {};
      for (const field of ['status', 'note', 'resumeRevisionId', 'appliedAt', 'followUpAt']) if (Object.hasOwn(patch, field) && application[field] !== patch[field]) { changes[field] = { from: application[field] ?? null, to: patch[field] }; application[field] = patch[field]; }
      // Build the current projection from the resolved association, but preserve
      // the historical jobId/legacyJobIds on the authoritative application row.
      w.applications[application.applicationId] = { ...application, jobId, ...(application.legacyJobIds ? { legacyJobIds: [jobId] } : {}) };
      const previousEvents = fence.queryRows(jobSelector('applicationEvents', scope, null, { where: { parentId: application.applicationId }, limit: 20, total: true }));
      const events = [...previousEvents.rows];
      const records = [descriptor('applications', application.applicationId, application, scope)];
      if (Object.keys(changes).length) {
        const maximum = fence.aggregateRows({ collection: 'applicationEvents', ownerPackageId: scope.packageId, where: { parentId: application.applicationId }, operation: 'max', field: 'ordinal' });
        const ordinal = maximum.groups[0]?.value == null ? 0 : maximum.groups[0].value + 1;
        const event = stamp({ type: 'application_updated', at: at(), changes }, scope.packageId);
        records.push(descriptor('applicationEvents', rowKey(application.applicationId, 'events', String(ordinal)), event, scope, { ordinal, parent: { collection: 'applications', id: application.applicationId, path: 'events' } }));
        events.push({ value: event }); application.manualHistory = true;
      }
      await persist(fence, scope, closed, records, [jobId, ...relatedIds], { recomputeDuplicates: true });
      return { ...application, events: events.map(row => row.value), eventsPage: { total: previousEvents.total + Number(Object.keys(changes).length > 0), hasMore: previousEvents.hasMore, nextCursor: previousEvents.nextCursor } };
    }, { scope });
  }
  async function finalizeCoverage({ runId, scope: selectedScope, coverage = [], detailEvidence = [], ...options }) {
    const scope = scoped(selectedScope); let updated = 0, cursor;
    do {
      const page = await repository.queryIds(jobSelector('jobs', scope, null, { ...(cursor ? { afterId: cursor } : {}), limit: 100, total: false }), { scope });
      for (const id of page.ids) await repository.withWriteFence(async fence => {
        const closed = await loadJobClosure(fence, scope, [id], { includeIdentity: true }), w = closed.workspace, job = w.jobs[id];
        const observations = Object.values(w.observations).filter(o => o.runId === runId), relevant = coverage.filter(c => job.sourceRefs.some(r => r.sourceId === c.sourceId && r.siteId === c.siteId)).map(c => ({ ...c, scopeKey: c.scopeKey || contentHash([c.sourceId, c.siteId, c.queries, c.cities]) }));
        job.absenceCounts ||= {}; job.observedScopes ||= {};
        for (const c of relevant) { c.previouslyObserved = !!job.observedScopes[c.scopeKey]; if (observations.some(o => o.sourceId === c.sourceId && o.siteId === c.siteId)) { job.observedScopes[c.scopeKey] = true; job.absenceCounts[c.scopeKey] = 0; } }
        const lifecycle = deriveLifecycle({ previous: job, observations, coverage: relevant, detailEvidence: detailEvidence.filter(e => e.jobId === id), now: new Date(clock.now()) });
        Object.assign(job, { lifecycle: lifecycle.state, lifecycleEvidence: lifecycle.evidence, deadlinePassed: lifecycle.deadlinePassed });
        for (const c of relevant) if (c.status === 'complete' && !c.truncated && c.previouslyObserved && !observations.some(o => o.sourceId === c.sourceId && o.siteId === c.siteId)) job.absenceCounts[c.scopeKey] = (job.absenceCounts[c.scopeKey] || 0) + 1;
        await persist(fence, scope, closed, [descriptor('jobs', id, job, scope)], [id], options);
      }, { scope, operationLease: options.operationLease });
      updated += page.ids.length; if (!page.hasMore) break; cursor = page.nextCursor;
    } while (cursor);
    return { updated };
  }
  async function link(a, b, selectedScope, unlink) {
    const scope = scoped(selectedScope); assertInput('link', { jobId: b }, { selfId: a });
    return repository.withWriteFence(async fence => {
      a = await resolveOwnedJobId(fence, scope, a); b = await resolveOwnedJobId(fence, scope, b);
      if (a === b) throw packageError('invalid_duplicate_selection', '不能将岗位关联到自身。', 400);
      const closed = await loadJobClosure(fence, scope, [a, b], { includeIdentity: true }), w = closed.workspace;
      const groupId = 'g-' + contentHash([a, b].sort()).slice(0, 24);
      const groupIds = [...new Set([...w.jobs[a].duplicateGroupIds || [], ...w.jobs[b].duplicateGroupIds || []])];
      const groups = groupIds.length ? fence.queryRows(jobSelector('duplicateGroups', scope, groupIds)).rows : [];
      const selected = unlink ? groups.filter(row => row.value.jobIds.includes(a) && row.value.jobIds.includes(b)) : [], removals = new Set(selected.map(row => row.id)), records = [];
      for (const id of [a, b]) { const job = w.jobs[id]; job.duplicateGroupIds = unlink ? (job.duplicateGroupIds || []).filter(group => !removals.has(group)) : [...new Set([...(job.duplicateGroupIds || []), groupId])]; records.push(descriptor('jobs', id, job, scope)); }
      if (!unlink) records.push(descriptor('duplicateGroups', groupId, { groupId, ownerPackageId: scope.packageId, jobIds: [a, b].sort(), manual: true, createdAt: at() }, scope));
      const projectionWorkspace = await applicationProjectionWorkspace(fence, w, scope);
      const derived = [a, b].flatMap(jobId => jobReadModelRecords(projectionWorkspace, { jobId, targetRevisionId: scope.targetRevisionId, asOf: clock.now() }));
      const receipt = fence.transaction({ select: explicitSelectors(scope, [], [...records, ...derived, ...selected.map(row => ({ ...row, collection: 'duplicateGroups' }))]) }, tx => { for (const row of selected) tx.deleteRow({ collection: 'duplicateGroups', id: row.id, ownerPackageId: scope.packageId }); for (const row of [...records, ...derived]) tx.putRow(row); return unlink ? { unlinked: [a, b] } : { linked: [a, b] }; });
      return receipt.result;
    }, { scope });
  }
  return { ingestRecords: ingest, saveEvaluations, getOperationMetrics: () => structuredClone(operationMetrics), queryJobs: filters => list(filters), queryApplications: filters => list(filters, true), getJob, getApplication,
    updateApplication: (id, patch, scope) => updateApplication(id, patch, scope, false), updateJobApplication: (id, patch, scope) => updateApplication(id, patch, scope, true),
    linkJobs: (a, b, scope) => link(a, b, scope, false), unlinkJobs: (a, b, scope) => link(a, b, scope, true), finalizeCoverage,
    async listUnresolvedApplications(filters = {}) { assertInput('filters', filters); return unresolvedPage(filters); } };
}
