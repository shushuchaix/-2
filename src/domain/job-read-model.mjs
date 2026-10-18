import { contentHash } from '../infrastructure/storage/content-hash.mjs';
import { RULE_VERSION } from './ranking-policy.mjs';
import { CONDITIONS_PARSER_VERSION, assessRecruitmentEvidence, gateRecommendation, resolveRecruitmentConditions } from './recruitment-evidence.mjs';
import { evaluateRules } from './ranking.mjs';
import { jobFactHash, selectMatchingEvaluation, selectVersionJobFact } from './job-facts.mjs';
import { resolveJobIdentity } from './identity.mjs';
import { identityText, jobBusinessFingerprint } from './job-identity.mjs';
import { duplicateSimHash } from './duplicate-candidates.mjs';
import { isManualApplication, projectJobApplication, resolveApplicationAssociation } from './job-resolution.mjs';
import { buildWorkspaceDuplicatePlan } from './job-duplicates.mjs';

export const JOB_READ_MODEL_VERSION = 4;
export const confirmedGroupHeadId = groupId => JSON.stringify(['confirmed-group', groupId]);
export const confirmedGroupMemberId = (groupId, jobId) => JSON.stringify(['confirmed-group-member', groupId, jobId]);
export function currentDuplicateStatus(projection, head) {
  const statuses = [projection?.duplicateStatus || 'normal', head?.status || 'normal'];
  return statuses.includes('protected') ? 'protected' : statuses.includes('possible') ? 'possible' : 'normal';
}
const hash = contentHash;
const key = (...parts) => JSON.stringify(parts);
const iso = value => new Date(value).toISOString();
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function legacyApplicationSeedRecords(application) {
  const seeds = application.legacyJobIds?.length ? application.legacyJobIds : [application.jobId];
  return [...new Set(seeds)].filter(seed => typeof seed === 'string' && seed).map(seed => ({
    collection: 'jobRelations', id: key('__legacy_application_seed_v1__', application.applicationId, seed), ownerPackageId: application.ownerPackageId,
    parent: { collection: 'applications', id: application.applicationId, path: 'legacyAssociationSeeds' },
    value: { kind: 'legacy_application_seed', resourceKey: seed, ownerPackageId: application.ownerPackageId },
  }));
}

/** Every dependency on `now` in evidence and qualification has an explicit boundary. */
export function jobTemporalBoundaries(record, profile = {}, asOf = Date.now()) {
  const now = Number(new Date(asOf)), candidates = [];
  const add = value => { if (Number.isFinite(value) && value > now) candidates.push(value); };
  const conditions = resolveRecruitmentConditions(record).conditions || [];
  const deadline = instant(record?.deadlineAt || record?.deadline);
  const opening = assessRecruitmentEvidence({ record, now }).openingStatus;
  if (deadline !== null && !['closed', 'historical'].includes(opening)) add(deadline + 1);
  const checked = instant(record?.applicationVerification?.checkedAt);
  if (checked !== null && record.applyUrl && record.applicationVerification.status === 200 && record.applicationVerification.formVerified === true && !record.applicationVerification.challenge) { add(checked); add(checked + 72 * 3600000 + 1); }
  for (const certificate of profile.certificates || []) {
    const until = instant(certificate?.registrationValidUntil);
    const required = conditions.filter(condition => condition.type === 'certificate').some(condition => (condition.certificateOptions || (condition.values || []).map(name => ({ name, grade: condition.grade, registrationRequired: condition.registrationRequired }))).some(option => option.registrationRequired && String(certificate?.name || '').includes(option.name) && (!option.grade || String(certificate?.name || '').includes(option.grade) || certificate?.grade === option.grade)));
    if (until !== null && required) add(until + 1);
  }
  if (conditions.some(condition => condition.type === 'age') && profile.age == null && profile.birthDate && Number.isFinite(Date.parse(profile.birthDate))) {
    const birth = new Date(profile.birthDate);
    // Only birthdays at an actual age predicate boundary change qualification.
    // Include 151: the qualification validator rejects own ages above 150.
    const ages = new Set([151, ...conditions.filter(c => c.type === 'age').flatMap(c => (c.values || []).flatMap(value => [value, value + 1]))]);
    for (const age of ages) if (Number.isInteger(age) && age >= 0 && age <= 151) add(Date.UTC(birth.getUTCFullYear() + age, birth.getUTCMonth(), birth.getUTCDate()));
  }
  return [...new Set(candidates)].sort((a, b) => a - b);
}
export const nextJobTemporalChangeAt = (record, profile, asOf) => { const times = jobTemporalBoundaries(record, profile, asOf); return times.length ? iso(times[0]) : null; };

export function currentProfileRevisionId(target) {
  return target?.profileSnapshot?.revisionId || null;
}

// Match the classifier's UTF16 slice behavior exactly, including astral text.
export const jobTitleGrams = title => { const text = identityText(title); return [...new Set([...text].slice(1).map((_, index) => text.slice(index, index + 2)))].sort(); };
export function jobTitleCandidateGrams(title) {
  const grams = jobTitleGrams(title);
  // Jaccard >= 82/100 implies at most 18/100 of either set is unshared.
  // Therefore the smallest shared gram occurs in both of these prefixes.
  return grams.slice(0, Math.floor(18 * grams.length / 100) + 1);
}

/** A stored evaluation cannot keep its qualification across a time boundary. */
export function projectCurrentEvaluation(evaluation, record, profile, asOf, target = {}) {
  if (!evaluation) return null;
  const evaluatedAt = instant(evaluation.evaluatedAsOf || evaluation.createdAt);
  const next = evaluatedAt === null ? null : nextJobTemporalChangeAt(record, profile, evaluatedAt);
  const stale = evaluatedAt === null || evaluatedAt > Number(new Date(asOf)) ||
    (next !== null && Date.parse(next) <= Number(new Date(asOf)));
  const invalidTime = evaluatedAt === null || evaluatedAt > Number(new Date(asOf));
  const selected = invalidTime ? { ...evaluation, qualification: { status: 'unknown', checks: [{ type: 'evaluation_time', status: 'unknown', reason: '评价时间未验证，需重新评价。' }] }, recommendation: 'insufficient', recommended: false, temporalStatus: 'needs_recalculation', requiresRecalculation: true }
    : stale ? { ...evaluation, ...evaluateRules(record, profile, target, { now: Number(new Date(asOf)) }), temporalStatus: 'current', temporalRecalculated: true, effectiveScoreSource: 'rules', requiresRecalculation: false }
    : { ...evaluation, temporalStatus: 'current', requiresRecalculation: false };
  const future = [nextJobTemporalChangeAt(record, profile, asOf), ...(evaluatedAt !== null && evaluatedAt > Number(new Date(asOf)) ? [iso(evaluatedAt)] : [])].filter(Boolean).sort();
  return { ...gateRecommendation(selected, record, Number(new Date(asOf))), evaluatedAsOf: evaluation.evaluatedAsOf || evaluation.createdAt || null, nextTemporalChangeAt: future[0] || null };
}

/** Pure single-job builder. The caller supplies only this job's closed read set. */
export function buildJobProjection(workspace, { jobId, targetRevisionId, asOf = Date.now() }) {
  const job = workspace.jobs[jobId], target = Object.values(workspace.targets).flat().find(t => t.revisionId === targetRevisionId);
  if (!job || !target) return null;
  const fact = selectVersionJobFact(workspace, { jobId, targetRevisionId });
  const record = fact.record || { title: job.canonical.title, company: job.canonical.company, kind: job.kind, cities: [] };
  const profile = target.profileSnapshot?.profile || {};
  const matched = selectMatchingEvaluation(workspace, { jobId, targetRevisionId, profileRevisionId: currentProfileRevisionId(target), factContentHash: fact.factContentHash });
  const evaluation = projectCurrentEvaluation(matched, record, profile, asOf, target);
  const application = projectJobApplication(workspace, jobId);
  const evidence = assessRecruitmentEvidence({ record, now: Number(new Date(asOf)) });
  const groupIds = job.duplicateGroupIds || [];
  const manualApplication = isManualApplication(application) || application.manualHistory === true || workspace.jobProjections?.[jobId]?.manualApplication === true;
  const protectedGroup = groupIds.length && manualApplication;
  const nextTemporalChangeAt = nextJobTemporalChangeAt(record, profile, asOf);
  // Maintenance can run under a wall clock different from a synthetic or restored
  // workspace's logical clock. Retain the timeline from the first known fact.
  const start = Math.min(Number(new Date(asOf)), instant(job.firstSeen) ?? Number(new Date(asOf)));
  const evaluatedAt = instant(matched?.evaluatedAsOf || matched?.createdAt);
  const times = [...new Set([start, ...jobTemporalBoundaries(record, profile, start), ...(evaluatedAt !== null && evaluatedAt > start ? [evaluatedAt] : [])])].sort((a, b) => a - b);
  const temporalPeriods = times.map((from, index) => {
    const current = projectCurrentEvaluation(matched, record, profile, from, target), evidence = assessRecruitmentEvidence({ record, now: from });
    return { from: iso(from), until: times[index + 1] ? iso(times[index + 1]) : null,
      score: current?.score || 0, qualification: current?.qualification?.status || 'unknown', recommendation: current?.recommendation || 'unevaluated', recommended: current?.recommended === true,
      openingStatus: evidence.openingStatus, applicationStatus: evidence.applicationStatus, temporalStatus: current?.temporalStatus || 'unevaluated' };
  });
  return {
    version: JOB_READ_MODEL_VERSION, jobId, ownerPackageId: job.ownerPackageId,
    targetRevisionId, profileRevisionId: currentProfileRevisionId(target),
    factContentHash: fact.factContentHash, observationIds: fact.observationIds,
    currentObservationId: workspace.targetMembers?.[targetRevisionId]?.[jobId]?.currentObservationId || null,
    evaluationId: evaluation?.evaluationId || null, applicationId: application.applicationId || null,
    ruleVersion: RULE_VERSION, conditionsParserVersion: CONDITIONS_PARSER_VERSION,
    title: record.title || '', company: record.company || '', kind: record.kind || job.kind,
    identityCompany: identityText(job.canonical.company), identityTitle: identityText(job.canonical.title),
    identityTitleGrams: jobTitleGrams(job.canonical.title), identityTitleGramCount: jobTitleGrams(job.canonical.title).length,
    jobType: record.jobType || null, cities: record.cities || [],
    sourceIds: [...new Set((job.sourceRefs || []).map(r => r.sourceId).filter(Boolean))],
    lifecycle: job.lifecycle || 'observed', lastSeen: job.lastSeen || '',
    score: evaluation?.score || 0, qualification: evaluation?.qualification?.status || 'unknown',
    recommendation: evaluation?.recommendation || 'unevaluated', recommended: evaluation?.recommended === true,
    openingStatus: evidence.openingStatus, applicationStatus: evidence.applicationStatus,
    bodyVerified: evidence.bodyVerified === true,
    applicationTrackingStatus: application.status || 'new',
    duplicateStatus: workspace.duplicateStatuses ? workspace.duplicateStatuses.get(jobId) || 'normal' : workspace.jobProjections?.[jobId]?.duplicateStatus || (groupIds.length ? 'possible' : 'normal'),
    confirmedDuplicateGroupId: workspace.confirmedDuplicateGroups?.get(jobId) || Object.values(workspace.jobRelations || {}).find(row => row.kind === 'confirmed_group_member' && row.jobId === jobId)?.groupId || null,
    manualApplication,
    searchText: [record.title, record.company, record.description, application.note].join(' ').toLowerCase(),
    asOf: iso(asOf), evaluatedAsOf: evaluation?.evaluatedAsOf || null,
    nextTemporalChangeAt, nextDueAt: nextTemporalChangeAt,
    temporalStatus: evaluation?.temporalStatus || 'unevaluated',
    temporalPeriods,
    bodySignature: jobBodySignature(record, workspace.identitySignatures, workspace.jobProjections?.[jobId]?.bodySignature),
  };
}

/** Stable conservative keys; four 16-bit blocks retain every SimHash distance <=3. */
export function jobBodySignature(record, cache = new Map(), previous) {
  if (String(record.description || '').trim().length < 30) return null;
  const contentHash = hash(record.description), retained = previous?.contentHash === contentHash ? previous : cache.get(contentHash);
  if (retained) { cache.set(contentHash, retained); return retained; }
  const signature = { contentHash, simHash: duplicateSimHash(record.description) };
  cache.set(contentHash, signature); return signature;
}
export function jobIdentityIndexKeys(record, aliases = [], { signatureCache = new Map(), previousSignature } = {}) {
  const identity = resolveJobIdentity(record), keys = new Map();
  const add = (kind, resourceKey) => { if (resourceKey) keys.set(key(kind, resourceKey), { kind, resourceKey }); };
  const hasBody = String(record.description || '').trim().length >= 30;
  for (const alias of [...identity.aliases, ...aliases]) {
    if (alias.startsWith('fields:') && (!identityText(record.company) || !identityText(record.title))) continue;
    add('alias', alias);
  }
  add('fingerprint', jobBusinessFingerprint(record));
  if (hasBody) add('content_hash', hash(record.description));
  // The deterministic Jaccard prefix retains every title pair the classifier
  // accepts. Full grams remain in the projection for the exact SQL predicate.
  if (identityText(record.company)) {
    const title = identityText(record.title);
    for (const gram of jobTitleCandidateGrams(title)) add('titlegram', key(identityText(record.company), gram));
  }
  if (hasBody) {
    const signature = jobBodySignature(record, signatureCache, previousSignature).simHash;
    for (let block = 0; block < 4; block++) add('simhash_' + block, key(identityText(record.company), signature.slice(block * 4, block * 4 + 4)));
  }
  return [...keys.values()];
}

export function jobReadModelRecords(workspace, input) {
  const projection = buildJobProjection(workspace, input);
  if (!projection) return [];
  const { jobId, ownerPackageId, targetRevisionId } = projection;
  const job = workspace.jobs[jobId];
  const records = [{ collection: 'jobProjections', id: jobId, ownerPackageId, jobId, targetRevisionId, value: projection }];
  for (const identity of jobIdentityIndexKeys(job.canonical, job.identityAliases, { signatureCache: workspace.identitySignatures, previousSignature: projection.bodySignature })) records.push({
    collection: 'jobIdentityKeys', id: key(jobId, identity.kind, identity.resourceKey), ownerPackageId, jobId,
    value: { jobId, ownerPackageId, ...identity, ...(identity.kind === 'content_hash' ? { bodySignature: projection.bodySignature } : {}) },
  });
  for (const observation of Object.values(workspace.observations)) if (observation.jobId === jobId && (observation.fields || observation.record)) records.push({
    collection: 'jobFactBasis', id: observation.observationId, ownerPackageId, jobId,
    value: { jobId, ownerPackageId, observationId: observation.observationId, factContentHash: jobFactHash(observation.fields || observation.record), targetRevisionId: observation.targetRevisionId || targetRevisionId },
  });
  return records;
}

export function buildJobDuplicateReadModel(workspace, { relations } = {}) {
  const compactGroups = relations ? [...Map.groupBy(relations.filter(row => row.kind === 'confirmed_group_member'), row => row.groupId)].map(([groupId, members]) => ({ groupId, jobIds: members.map(member => member.jobId), reasonCodes: relations.find(row => row.kind === 'confirmed_group_head' && row.groupId === groupId)?.reasonCodes || [] })) : [];
  const plan = buildWorkspaceDuplicatePlan({ ...workspace, _scope: workspace._scope || {} }, { readModelOnly: true, ...(relations ? { preclassifiedRelations: relations.filter(relation => ['possible', 'confirmed'].includes(relation.relation)), preclassifiedGroups: compactGroups } : {}) });
  const statuses = new Map(), possibleStatuses = new Map();
  for (const pair of plan.possiblePairs) for (const id of pair.jobIds) statuses.set(id, 'possible');
  for (const [id, status] of statuses) possibleStatuses.set(id, status);
  for (const group of plan.groups) for (const id of [group.keepJobId, ...group.removeJobIds]) statuses.set(id, group.protected ? 'protected' : statuses.get(id) === 'protected' ? 'protected' : 'possible');
  const pairRelations = plan.possiblePairs.map(pair => ({ jobId: pair.jobIds[0], otherJobId: pair.jobIds[1], relation: 'possible', reasonCodes: pair.reasonCodes }));
  // A confirmed clique is represented by a head and one membership per job.
  // Do not materialize every directed pair of a large equivalent group.
  return { statuses, possibleStatuses, relations: pairRelations, groups: plan.groups };
}
export const buildJobDuplicateStatuses = (workspace, options) => buildJobDuplicateReadModel(workspace, options).statuses;

/** Import/replace maintenance only; never invoked by an ordinary GET. */
export function buildWorkspaceJobReadModels(workspace, { asOf = Date.now() } = {}) {
  if (workspace.schemaVersion !== 3) return [];
  const observations = new Map(), evaluations = new Map(), applications = new Map(), aliases = new Map();
  for (const [alias, ids] of Object.entries(workspace.identityAliases || {})) for (const id of ids) { const list = aliases.get(id) || []; list.push(alias); aliases.set(id, list); }
  for (const [collection, index] of [['observations', observations], ['evaluations', evaluations], ['applications', applications]]) for (const row of Object.values(workspace[collection] || {})) {
    const list = index.get(row.jobId) || []; list.push(row); index.set(row.jobId, list);
  }
  const result = Object.values(workspace.applications).flatMap(legacyApplicationSeedRecords), identitySignatures = new Map(), singleApplications = new Map(), manualCandidateJobs = new Set();
  const owners = Map.groupBy(Object.values(workspace.jobs), job => job.ownerPackageId), duplicateStatuses = new Map(), confirmedDuplicateGroups = new Map();
  for (const [owner, jobs] of owners) {
    const ownerView = { schemaVersion: 3, _scope: { packageId: owner }, revision: workspace.revision, jobs: Object.fromEntries(jobs.map(job => [job.jobId, job])),
      applications: Object.fromEntries(Object.entries(workspace.applications).filter(([, app]) => app.ownerPackageId === owner)), identityAliases: workspace.identityAliases, jobRedirects: workspace.jobRedirects || {}, targetMembers: {} };
    // Resolve historical associations with the real owner identity graph before
    // reducing to one job. Preserve raw applications for duplicate protection.
    for (const application of Object.values(ownerView.applications)) {
      const association = resolveApplicationAssociation(ownerView, application);
      if (isManualApplication(application)) association.jobIds.forEach(id => manualCandidateJobs.add(id));
      if (association.status === 'single') {
        const id = association.jobIds[0], list = singleApplications.get(id) || [];
        list.push({ ...application, jobId: id, ...(application.legacyJobIds ? { legacyJobIds: [id] } : {}) }); singleApplications.set(id, list);
      }
    }
    const duplicate = buildJobDuplicateReadModel(ownerView);
    for (const [id, status] of duplicate.possibleStatuses) duplicateStatuses.set(id, status);
    for (const relation of duplicate.relations) for (const [jobId, otherJobId] of [[relation.jobId, relation.otherJobId], [relation.otherJobId, relation.jobId]]) result.push({ collection: 'jobRelations', id: key(jobId, otherJobId), ownerPackageId: owner, jobId, value: { ...relation, jobId, otherJobId, ownerPackageId: owner } });
    for (const group of duplicate.groups) {
      const ids = [group.keepJobId, ...group.removeJobIds], groupId = 'cg-' + hash([owner, group.keepJobId]).slice(0, 24);
      const head = { jobId: group.keepJobId, otherJobId: group.keepJobId, groupId, ownerPackageId: owner, kind: 'confirmed_group_head', resourceKey: groupId, relation: 'confirmed_group', representativeJobId: group.keepJobId, memberCount: ids.length, manualApplicationCount: group.manualApplicationCount, status: group.protected ? 'protected' : 'possible', reasonCodes: group.reasonCodes };
      result.push({ collection: 'jobRelations', id: confirmedGroupHeadId(groupId), ownerPackageId: owner, jobId: group.keepJobId, value: head });
      for (const jobId of ids) {
        confirmedDuplicateGroups.set(jobId, groupId);
        const manualApplicationCount = (applications.get(jobId) || []).filter(isManualApplication).length;
        result.push({ collection: 'jobRelations', id: confirmedGroupMemberId(groupId, jobId), ownerPackageId: owner, jobId, value: { jobId, groupId, ownerPackageId: owner, kind: 'confirmed_group_member', resourceKey: groupId, relation: 'confirmed_group', manualApplicationCount } });
      }
    }
  }
  for (const job of Object.values(workspace.jobs)) {
    const pkg = workspace.packages[job.ownerPackageId];
    if (pkg?.kind !== 'target') continue;
    const target = Object.values(workspace.targets).flat().find(t => t.revisionId === pkg.versionId);
    if (!target) continue;
    const indexedJob = { ...job, identityAliases: [...new Set([...(job.identityAliases || []), ...(aliases.get(job.jobId) || [])])] };
    const view = { schemaVersion: 3, identitySignatures, duplicateStatuses, confirmedDuplicateGroups, jobs: { [job.jobId]: indexedJob }, targets: { [target.targetId]: [target] }, targetMembers: { [target.revisionId]: { [job.jobId]: workspace.targetMembers?.[target.revisionId]?.[job.jobId] } },
      observations: Object.fromEntries((observations.get(job.jobId) || []).map(o => [o.observationId, o])), evaluations: Object.fromEntries((evaluations.get(job.jobId) || []).map(e => [e.evaluationId, e])),
      applications: Object.fromEntries((singleApplications.get(job.jobId) || []).map(a => [a.applicationId, a])), identityAliases: {}, jobRedirects: {}, duplicateGroups: workspace.duplicateGroups || {},
      jobProjections: { [job.jobId]: { manualApplication: manualCandidateJobs.has(job.jobId) } } };
    result.push(...jobReadModelRecords(view, { jobId: job.jobId, targetRevisionId: target.revisionId, asOf }));
  }
  return result;
}
