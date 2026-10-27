import { assertSourceRecord } from "../domain/contracts.mjs";
import { createHash } from 'node:crypto';
import { expandArticles } from '../match/article.mjs';
import { articleParts } from '../sources/content-queue.mjs';

const fail = code => Object.assign(Error(code), { code });
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scalarFields = ['sourceId','siteId','identityScope','sourceRecordId','sourceRecordIdKind',
  'title','url','company','sourceName','description','publishedAt','publishTime','deadlineAt',
  'bodyStatus','detailStatus','parserVersion','bodyHash','applyUrl'];
const locationFields = ['sheet','table','page','row','column','cell','cellRange','jobRowId','start','end'];
const location = input => Object.fromEntries(locationFields.flatMap(key => {
  const value = input?.[key];
  return typeof value === 'string' && value.length <= 300 || Number.isFinite(value)
    ? [[key,value]] : [];
}));

/** Only source facts enter the article extractor. In particular no profile,
 * target, credentials, private metadata or arbitrary extra object is copied. */
export function publicNoticeForExpansion(record) {
  assertSourceRecord(record);
  if (!record || record.kind !== 'recruitment_notice' || typeof record.description !== 'string' ||
      typeof record.title !== 'string' || !record.title.trim() || record.description.length > 2 * 1024 * 1024)
    throw fail('notice_expansion_input_invalid');
  const out = { kind:'recruitment_notice' };
  for (const key of scalarFields) if (typeof record[key] === 'string' || record[key] === null) out[key] = record[key];
  for (const key of ['bodyIncomplete','rowAmbiguous','attachmentBodyPending'])
    if (typeof record[key] === 'boolean') out[key] = record[key];
  // Local evidence metadata, not a prompt field. Never raise low OCR confidence
  // to the extractor's default 100, and include it in the guarded input basis.
  if (Object.hasOwn(record, 'ocrConfidence')) {
    if (!Number.isFinite(record.ocrConfidence) || record.ocrConfidence < 0 || record.ocrConfidence > 100)
      throw fail('notice_expansion_input_invalid');
    out.ocrConfidence = record.ocrConfidence;
  }
  if (typeof record.extra?.account === 'string') out.extra = { account:record.extra.account };
  if (record.attachmentRows !== undefined) {
    if (!Array.isArray(record.attachmentRows) || record.attachmentRows.length > 2000)
      throw fail('notice_expansion_input_invalid');
    out.attachmentRows = record.attachmentRows.map(row => {
      if (!row || typeof row.text !== 'string' || typeof row.jobRowId !== 'string' ||
          !Array.isArray(row.cells) || row.cells.length > 500) throw fail('notice_expansion_input_invalid');
      return { jobRowId:row.jobRowId, ...(typeof row.sourceUrl === "string" ? {sourceUrl:row.sourceUrl} : {}), text:row.text,
        ambiguous:row.ambiguous === true,
        cells:row.cells.map(cell => ({
          ...(typeof cell.text === 'string' ? {text:cell.text} : {}),
          ...(Number.isFinite(cell.confidence) ? {confidence:cell.confidence} : {}),
          ambiguousMerge:cell.ambiguousMerge === true, location:location(cell.location),
        })) };
    });
  }
  if (Buffer.byteLength(JSON.stringify(out)) > 4 * 1024 * 1024) throw fail('notice_expansion_input_invalid');
  return out;
}

/** Shared production boundary. Durable cache, typed publication and owner/epoch
 * guards remain with existing callers; no alternate queue or model factory.
 * A formal narrow batch can impose stricter admission without weakening the
 * client's existing persistent model budget or its conservative reservation. */
export async function expandRecruitmentNotice({
  record, modelClient, signal, diagnostics, diagnosticContext = {},
  assertCurrent, maxRequests = Infinity,
  admitModelRequest, singleAttempt = false,
} = {}) {
  if (!modelClient || typeof modelClient.chatJson !== 'function' || typeof assertCurrent !== 'function' ||
      !(maxRequests === Infinity || Number.isSafeInteger(maxRequests) && maxRequests >= 0))
    throw fail('notice_expansion_input_invalid');
  const notice = publicNoticeForExpansion(record), basis = fingerprint(notice);
  const parts = articleParts(notice.description);
  if (parts.length > maxRequests) throw fail('model_budget_exhausted');
  let requests = 0, controlError, stopped = false;
  const stop = error => {
    if (!stopped) { stopped = true; controlError = error; }
    return controlError;
  };
  const refuseStopped = () => { if (stopped) throw controlError; };
  const current = async () => {
    refuseStopped();
    try {
      signal?.throwIfAborted();
      refuseStopped();
      await assertCurrent();
      refuseStopped();
      signal?.throwIfAborted();
      if (fingerprint(publicNoticeForExpansion(record)) !== basis)
        throw fail('collection_source_fact_changed');
    } catch (error) { throw stop(error); }
  };
  await current();
  refuseStopped();
  const client = { async chatJson(system, user, options) {
    refuseStopped();
    await current();
    refuseStopped();
    if (requests >= maxRequests) {
      throw stop(fail('model_budget_exhausted'));
    }
    try {
      refuseStopped();
      await admitModelRequest?.({ model:modelClient.model, baseUrl:modelClient.baseUrl,
        maxOutputTokens:options.maxTokens, inputCharacters:system.length + user.length });
      refuseStopped();
    } catch (error) { throw stop(error); }
    await current();
    refuseStopped();
    requests++;
    const response = await modelClient.chatJson(system, user, {
      ...options, ...(singleAttempt ? {retries:0} : {}), repair:false,
    });
    refuseStopped();
    await current();
    refuseStopped();
    return response;
  }};
  let result;
  try {
    refuseStopped();
    result = await expandArticles(client, {}, [notice], {
      concurrency:1, signal, diagnostics, diagnosticContext,
    });
  } catch (error) { refuseStopped(); throw error; }
  refuseStopped();
  await current();
  refuseStopped();
  // Logical calls are not transport counts; the formal ledger is authoritative.
  return { ...result, modelCalls:requests, singleAttempt };
}