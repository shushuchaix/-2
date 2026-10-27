import test from 'node:test';
import assert from 'node:assert/strict';
import { expandRecruitmentNotice, publicNoticeForExpansion } from '../../src/application/notice-expansion-service.mjs';
import { manualEmailAddress, officialEmailCandidate, assertApplicationChannels } from '../../src/domain/application-channels.mjs';
import { mergeRecruitmentFacts } from '../../src/domain/duplicate-candidates.mjs';
import { jobFactHash } from '../../src/domain/job-facts.mjs';
import { assessRecruitmentEvidence, isVerifiedRecommendation } from '../../src/domain/recruitment-evidence.mjs';
import { assertSourceRecord, createEmptyWorkspace } from '../../src/domain/contracts.mjs';
import { baseRecord } from '../../src/sources/adapters/shared.mjs';
import { expandArticles } from '../../src/match/article.mjs';
import { articleParts } from '../../src/sources/content-queue.mjs';
import { extractRecruitmentConditions } from '../../src/domain/recruitment-evidence.mjs';
import { evaluateEvidenceQualification } from '../../src/domain/qualification.mjs';
import { ingestRecordsDraft } from '../../src/domain/ingest-records.mjs';
import { normalizeRecord } from '../../src/domain/record.mjs';
import { relateJobs } from '../../src/domain/identity.mjs';
import { jobBusinessContent } from '../../src/domain/job-identity.mjs';

const body='报名截止：2026-11-30\n消防工程师：本科消防工程专业，负责消防设备检查和应急预案管理。工作地点：北京。';
const notice = patch => ({sourceId:'synthetic',siteId:'site',identityScope:'site',sourceRecordId:'notice-1',
  sourceRecordIdKind:'authority',kind:'recruitment_notice',title:'合成消防招聘公告',company:'合成单位',cities:[],jobType:'unknown',
  url:'https://example.org/notices/1',description:body,bodyStatus:'complete',detailStatus:'complete',evidence:[],parserVersion:'fixture-1',...patch});
const answer = patch => ({isRecruiting:true,company:'合成单位',deadline:'2026-11-30',positions:[{
  title:'消防工程师',education:'本科',major:'消防工程',city:'北京',requirementsExcerpt:'本科消防工程专业，负责消防设备检查和应急预案管理。',
}],...patch});
const current = async () => {};
const deferred = () => { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; };
const emailRecord = () => baseRecord({id:'career-1',sourceRecordIdKind:'authority',sourceId:'official-announcements',siteId:'gst',scope:'gst',
  title:'消防工程师',url:'https://example.org/careers#career-1',description:body,bodyStatus:'complete'});
const email = (record,address='hr@example.invalid',at='2026-10-27T00:00:00Z') => officialEmailCandidate({record,address,
  sourceUrl:'https://example.org/careers',observedAt:at,instructionExcerpt:'简历投递邮箱',selector:'.career-meta-row a[href]'});

test('common service produces a separate literal-backed job and stable source identity without mutating notice',async()=>{
  const record=notice(),before=structuredClone(record);let calls=0;
  const input={record,assertCurrent:current,modelClient:{chatJson:async()=>{calls++;return answer();}}};
  const result=await expandRecruitmentNotice(input),again=await expandRecruitmentNotice(input);
  assert.equal(result.failed,0);assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].kind,'job');
  assert.equal(result.jobs[0].derivedFrom,record.sourceRecordId);assert.equal(result.jobs[0].sourceRecordId,again.jobs[0].sourceRecordId);
  assert.equal(result.jobs[0].description,answer().positions[0].requirementsExcerpt);assert.deepEqual(record,before);assert.equal(calls,2);
});
test('private profile, target, credential and arbitrary nested row metadata cannot enter extractor payload',async()=>{
  const record=notice({profile:{text:'PRIVATE_PROFILE_CANARY'},target:{versionName:'PRIVATE_TARGET_CANARY'},apiKey:'PRIVATE_KEY_CANARY',
    extra:{account:'官方招聘',privateNote:'PRIVATE_EXTRA_CANARY'},attachmentRows:[{jobRowId:'row1',sourceUrl:'https://example.org/table.xlsx',
      text:'消防工程师 '+answer().positions[0].requirementsExcerpt,ambiguous:false,privateValue:'PRIVATE_ROW_CANARY',
      cells:[{text:answer().positions[0].requirementsExcerpt,confidence:100,privateValue:'PRIVATE_CELL_CANARY',location:{row:2,cell:'B2',privateValue:'PRIVATE_LOCATION_CANARY'}}]}]});
  const projected=publicNoticeForExpansion(record);assert.equal(JSON.stringify(projected).includes('CANARY'),false);
  let sent;
  await expandRecruitmentNotice({record,assertCurrent:current,modelClient:{chatJson:async(system,user)=>{sent=system+user;return answer();}}});
  assert.equal(sent.includes('CANARY'),false);assert.ok(sent.includes('消防工程师'));
});
test('another role or ambiguous attachment row cannot supply verified requirements',async()=>{
  const records=[notice({description:body+'\n安全助理：大专，经验不限。'}),notice({attachmentRows:[{jobRowId:'r',sourceUrl:'https://example.org/jobs.xlsx',
    text:'消防工程师 '+answer().positions[0].requirementsExcerpt,ambiguous:true,cells:[{text:'本科',confidence:100,location:{row:2}}]}]})];
  for(const [i,record] of records.entries()){
    const response=i===0?answer({positions:[{title:'消防工程师',requirementsExcerpt:'安全助理：大专，经验不限。'}]}):answer();
    const result=await expandRecruitmentNotice({record,assertCurrent:current,modelClient:{chatJson:async()=>response}});
    assert.equal(result.jobs.length,0);
  }
});
test('model failure is not success-empty and does not mutate notice',async()=>{
  const record=notice(),before=structuredClone(record);
  const result=await expandRecruitmentNotice({record,assertCurrent:current,modelClient:{chatJson:async()=>{throw Error('synthetic transport failure');}}});
  assert.equal(result.failed,1);assert.equal(result.jobs.length,0);assert.deepEqual(record,before);
});
test('two-request limit counts article parts before any call, and narrow policy disables retry and repair',async()=>{
  let calls=0,opts;
  await assert.rejects(expandRecruitmentNotice({record:notice({description:'x'.repeat(18000)}),maxRequests:2,assertCurrent:current,
    modelClient:{chatJson:async()=>{calls++;return answer();}}}),{code:'model_budget_exhausted'});assert.equal(calls,0);
  await expandRecruitmentNotice({record:notice(),maxRequests:2,singleAttempt:true,assertCurrent:current,
    modelClient:{chatJson:async(_s,_u,o)=>{opts=o;return answer();}}});
  assert.equal(opts.retries,0);assert.equal(opts.repair,false);
});
test('admission failure remains original and creates no request',async()=>{
  const reason=Object.assign(Error('denied'),{code:'model_pricing_unsupported'});let calls=0;
  await assert.rejects(expandRecruitmentNotice({record:notice(),assertCurrent:current,admitModelRequest:async()=>{throw reason;},
    modelClient:{chatJson:async()=>{calls++;return answer();}}}),e=>e===reason);assert.equal(calls,0);
});
for(const mode of ['cancel','source fact','authority'])test('late model reply cannot publish after '+mode,async()=>{
  const record=notice(),entered=deferred(),reply=deferred(),controller=new AbortController(),reason=Error('authority changed');let changed=false;
  const pending=expandRecruitmentNotice({record,signal:controller.signal,assertCurrent:async()=>{if(changed)throw reason;},
    modelClient:{chatJson:async()=>{entered.resolve();return reply.promise;}}});
  await entered.promise;
  if(mode==='cancel')controller.abort(reason);else if(mode==='source fact')record.description+=' 新批次。';else changed=true;
  reply.resolve(answer());
  await assert.rejects(pending,e=>mode==='source fact'?e.code==='collection_source_fact_changed':e===reason);
});
test('manual email accepts official different-domain address but rejects URI injection and malformed addresses',()=>{
  assert.equal(manualEmailAddress('mailto:HR+fire@Example.INVALID'),'HR+fire@example.invalid');
  for(const value of ['hr@example.invalid?bcc=other@example.invalid','hr@example.invalid/path','hr@example.invalid:25',
    'hr@example.invalid\r\nBcc:other@example.invalid','a@example.invalid,b@example.invalid','../x@example.invalid','a@localhost','a@example.invalid#frag'])
    assert.equal(manualEmailAddress(value),null,value);
  const r=emailRecord(),candidate=email(r,'published-hr@another.invalid');assert.ok(candidate);assertApplicationChannels([candidate]);
  assert.throws(()=>assertApplicationChannels([{...candidate,submitted:true}]));
});
test('channel survives base record and fact merging without elevating recommendation, and complete same-source removal revokes it',()=>{
  const r=emailRecord(),candidate=email(r);r.applicationChannels=[candidate];assertSourceRecord(r);
  const normalized=baseRecord({...r,id:r.sourceRecordId,scope:r.identityScope});assert.deepEqual(normalized.applicationChannels,[candidate]);
  const merged=mergeRecruitmentFacts(r,{...r,applicationChannels:[email(r,'updated@example.invalid','2026-10-28T00:00:00Z')]});
  assert.deepEqual(merged.applicationChannels.map(c=>c.address),['updated@example.invalid']);
  const without=mergeRecruitmentFacts(merged,{...r,applicationChannels:[]});assert.deepEqual(without.applicationChannels,[]);
  const evidence=assessRecruitmentEvidence({record:r,now:Date.parse('2026-10-27')});
  assert.equal(evidence.applicationStatus,'unknown');assert.equal(isVerifiedRecommendation({qualification:{status:'pass'},evidence}),false);
  assert.equal(jobFactHash(r),jobFactHash({...r,applicationChannels:[{...candidate,observedAt:'2026-10-28T00:00:00Z'}]}));
  assert.notEqual(jobFactHash(r),jobFactHash(merged));
});
// R1: the legacy expander catches nonfatal block failures. Admission control is
// sticky at the common boundary, including before all later block attempts.
test('first admission error is sticky across two article blocks with zero later admissions or model requests',async()=>{
  const record=notice({description:body+'\n'+'公开段落。'.repeat(1300)}),before=structuredClone(record);
  assert.equal(articleParts(record.description).length,2);
  const reason=Object.assign(Error('pricing no longer supported'),{code:'model_pricing_unsupported'});
  let admissions=0,calls=0;
  await assert.rejects(expandRecruitmentNotice({record,assertCurrent:current,maxRequests:2,
    admitModelRequest:async()=>{admissions++;if(admissions===1)throw reason;},
    modelClient:{chatJson:async()=>{calls++;return answer();}}}),error=>error===reason);
  assert.equal(admissions,1);assert.equal(calls,0);assert.deepEqual(record,before);
});

// R2: this is compatibility for an existing legal extractor input, not a claim
// that a current producer or an online sample already emits OCR confidence.
for(const confidence of [40,93])test('local OCR confidence '+confidence+' matches the existing extractor without being promoted',async()=>{
  const excerpt='本科，专业要求：消防工程。负责消防设备检查和应急预案管理。';
  const record=notice({description:'消防工程师：'+excerpt,ocrConfidence:confidence}),response=answer();let sent='';
  response.positions[0].requirementsExcerpt=excerpt;
  const original=await expandArticles({chatJson:async()=>response}, {}, [record], {concurrency:1});
  const common=await expandRecruitmentNotice({record,assertCurrent:current,modelClient:{chatJson:async(system,user)=>{
    sent=system+user;return response;
  }}});
  assert.equal(original.jobs.length,1);assert.equal(common.jobs.length,1);
  assert.deepEqual(common.jobs[0].sourceEvidence,original.jobs[0].sourceEvidence);
  assert.equal(common.jobs[0].sourceEvidence[0].confidence,confidence);
  assert.equal(publicNoticeForExpansion(record).ocrConfidence,confidence);
  assert.equal(sent.includes('ocrConfidence'),false);
  const extracted=extractRecruitmentConditions(common.jobs[0]);
  assert.ok(extracted.conditions.length>0);assert.ok(extracted.sourceEvidence.length>0);
  assert.ok(extracted.sourceEvidence.every(e=>e.confidence===confidence));
  if(confidence<85){
    const checked=evaluateEvidenceQualification({profileSnapshot:{major:'消防工程'},...extracted});
    assert.equal(checked.status,'unknown');
    assert.ok(checked.checks.every(check=>check.status==='unknown'));
    assert.ok(checked.checks.every(check=>check.reason==='条件证据不完整或未确认对应岗位行'));
  }
});
test('illegal explicit OCR confidence rejects before model admission rather than defaulting to 100',async()=>{
  let admissions=0,calls=0;
  for(const confidence of [NaN,Infinity,-1,101,'40',null,undefined]){
    const record=notice({ocrConfidence:confidence});
    assert.throws(()=>publicNoticeForExpansion(record),{code:'notice_expansion_input_invalid'});
    await assert.rejects(expandRecruitmentNotice({record,assertCurrent:current,
      admitModelRequest:async()=>{admissions++;},modelClient:{chatJson:async()=>{calls++;return answer();}}}),{code:'notice_expansion_input_invalid'});
  }
  assert.equal(admissions,0);assert.equal(calls,0);
});
test('changing only local OCR confidence while awaiting model response rejects the old evidence basis',async()=>{
  const record=notice({ocrConfidence:40}),entered=deferred(),reply=deferred();let calls=0;
  const pending=expandRecruitmentNotice({record,assertCurrent:current,modelClient:{chatJson:async()=>{
    calls++;entered.resolve();return reply.promise;
  }}});
  await entered.promise;record.ocrConfidence=93;reply.resolve(answer());
  await assert.rejects(pending,{code:'collection_source_fact_changed'});assert.equal(calls,1);
});
// Exact producer replay is scoped input idempotency, not a stronger claim that
// weak generated records are duplicates across notices, sites or positions.
async function companyUnknownPosition(patch = {}) {
  const result = await expandRecruitmentNotice({record:notice(patch),assertCurrent:current,
    modelClient:{chatJson:async()=>({isRecruiting:true,positions:answer().positions})}});
  assert.equal(result.jobs.length,1);
  const record = normalizeRecord(result.jobs[0]);
  assert.equal(record.company,null);
  return record;
}
function ingestReplayPair(left,right) {
  const w = createEmptyWorkspace({schemaVersion:2}), observedAt='2026-10-27T00:00:00.000Z';
  w.runs.first={runId:'first'};w.runs.second={runId:'second'};
  const first=ingestRecordsDraft(w,{runId:'first',records:[left],observedAt}).jobIds[0];
  const second=ingestRecordsDraft(w,{runId:'second',records:[right],observedAt}).jobIds[0];
  return {w,first,second};
}
test('generated company-unknown literal position replays one job with two observations without changing generic identity policy',async()=>{
  const record=await companyUnknownPosition(),fresh=structuredClone(record);
  fresh.retrievedAt='2026-10-28T00:00:00.000Z';fresh.sourceEvidence[0].observedAt=fresh.retrievedAt;
  assert.deepEqual(jobBusinessContent(normalizeRecord(fresh)),jobBusinessContent(record));
  assert.deepEqual(relateJobs(record,fresh),{relation:'distinct',reasons:['insufficient_identity_evidence']});
  const {w,first,second}=ingestReplayPair(record,fresh);
  assert.equal(first,second);assert.equal(Object.keys(w.jobs).length,1);
  assert.equal(Object.values(w.observations).filter(o=>o.jobId===first).length,2);
  assert.equal(w.jobs[first].canonical.sourceRecordIdKind,'generated');
  assert.equal(w.jobs[first].canonical.company,null);
});
const replayRefusals=[
  ['missing parent on both records',(left,right)=>{delete left.derivedFrom;delete right.derivedFrom;}],
  ['different parent',(_left,right)=>{right.derivedFrom='another-notice';}],
  ['different generated position ID',(_left,right)=>{right.sourceRecordId=right.derivedFrom+':position:other:'+ '1'.repeat(24);}],
  ['different source',(_left,right)=>{right.sourceId='another-source';}],
  ['different site in same scope',(_left,right)=>{right.siteId='another-site';}],
  ['different identity scope',(_left,right)=>{right.identityScope='another-scope';}],
  ['different source URL',(_left,right)=>{right.url='https://example.org/notices/another';}],
  ['different recruitment batch',(_left,right)=>{right.batch='2027-second-batch';}],
  ['different city',(_left,right)=>{right.cities=['上海'];}],
  ['another position in the same parent',(_left,right)=>{right.title='机场安全助理';right.sourceRecordId=right.derivedFrom+':position:airport:'+ '2'.repeat(24);}],
  ['changed requirements literal',(_left,right)=>{right.description+='新增机场消防设备管理职责。';}],
  ['different required condition',(_left,right)=>{right.requiredCertificates=['一级注册消防工程师'];}],
  ['different attachment row',(_left,right)=>{right.jobRowId='another-row';}],
  ['description assigned to another row',(_left,right)=>{right.sourceEvidence[0].appliesTo.jobRowId='another-row';}],
  ['different literal location',(_left,right)=>{right.sourceEvidence[0].location.start++;right.sourceEvidence[0].location.end++;}],
  ['different body fingerprint',(_left,right)=>{right.sourceEvidence[0].contentHash='another-body';}],
  ['unverified description',(_left,right)=>{right.sourceEvidence[0].status='unknown';}],
  ['ambiguous row',(_left,right)=>{right.rowAmbiguous=true;}],
  ['low-confidence literal evidence',(_left,right)=>{right.sourceEvidence[0].confidence=40;}],
  ['changed description proof value',(_left,right)=>{right.sourceEvidence[0].value='另一岗位正文';}],
  ['known evidence conflict',(_left,right)=>{right.evidenceConflicts=[{field:'description',code:'visible_structured_conflict'}];}],
  ['missing literal proof on both records',(left,right)=>{left.sourceEvidence=[];right.sourceEvidence=[];}],
];
for(const [label,change] of replayRefusals)test('generated replay does not collapse '+label,async()=>{
  const left=await companyUnknownPosition(),right=structuredClone(left);change(left,right);
  const {w,first,second}=ingestReplayPair(left,right);
  assert.notEqual(first,second);assert.equal(Object.keys(w.jobs).length,2);
  assert.equal(w.jobs[first].canonical.sourceRecordIdKind,'generated');
  assert.equal(w.jobs[second].canonical.sourceRecordIdKind,'generated');
});
test('real attachment-derived replay keeps one job only for the same literal cells and row binding',async()=>{
  const excerpt=answer().positions[0].requirementsExcerpt;
  const record=await companyUnknownPosition({attachmentRows:[{jobRowId:'row-1',sourceUrl:'https://example.org/jobs.xlsx',
    text:'消防工程师 '+excerpt,ambiguous:false,cells:[{text:excerpt,confidence:100,location:{sheet:'岗位表',table:0,row:2,column:1}}]}]});
  assert.equal(record.jobRowId,'row-1');assert.equal(record.sourceEvidence[0].sourceKind,'attachment');
  const same=ingestReplayPair(record,structuredClone(record));assert.equal(same.first,same.second);
  const anotherRow=structuredClone(record);anotherRow.jobRowId='row-2';
  for(const evidence of anotherRow.sourceEvidence){
    if(evidence.appliesTo?.jobRowId==='row-1')evidence.appliesTo.jobRowId='row-2';
    if(evidence.location?.jobRowId==='row-1')evidence.location.jobRowId='row-2';
  }
  const separate=ingestReplayPair(record,anotherRow);assert.notEqual(separate.first,separate.second);
  assert.equal(Object.keys(separate.w.jobs).length,2);
});
// R1: real article output places these qualifiers in extra, outside the generic
// business fingerprint. Missing model fields must not erase a known first value.
async function positionWithProducerExtra(fields = {}) {
  const excerpt=answer().positions[0].requirementsExcerpt;
  const record=notice({description:'消防工程师：批次A，招聘2人，采用邮箱投递。'+excerpt+'工作地点：北京。'});
  const response={isRecruiting:true,positions:[{...answer().positions[0],
    ...(Object.hasOwn(fields,'headcount')?{headcount:fields.headcount}:{})}],
    ...(Object.hasOwn(fields,'batch')?{batch:fields.batch}:{}),
    ...(Object.hasOwn(fields,'applyMethod')?{applyMethod:fields.applyMethod}:{})};
  const result=await expandRecruitmentNotice({record,assertCurrent:current,modelClient:{chatJson:async()=>response}});
  assert.equal(result.jobs.length,1);
  const position=normalizeRecord(result.jobs[0]);assert.equal(position.company,null);
  return position;
}
for(const [field,value] of [['batch','批次A'],['headcount','2人'],['applyMethod','邮箱投递']])
  test('real producer known '+field+' then omitted value keeps separate job and retains the first qualifier',async()=>{
    const left=await positionWithProducerExtra({[field]:value}),right=await positionWithProducerExtra();
    assert.equal(left.extra[field],value);assert.equal(right.extra[field],'');
    assert.equal(left.sourceRecordId,right.sourceRecordId);
    assert.deepEqual(jobBusinessContent(left),jobBusinessContent(right));
    assert.deepEqual(left.sourceEvidence[0],right.sourceEvidence[0]);
    assert.deepEqual(relateJobs(left,right),{relation:'distinct',reasons:['insufficient_identity_evidence']});
    const {w,first,second}=ingestReplayPair(left,right);
    assert.notEqual(first,second);assert.equal(Object.keys(w.jobs).length,2);
    assert.equal(w.jobs[first].canonical.extra[field],value);
    assert.equal(w.jobs[second].canonical.extra[field],'');
  });
test('two real producer outputs with the same complete extra remain idempotent',async()=>{
  const fields={batch:'批次A',headcount:'2人',applyMethod:'邮箱投递'};
  const left=await positionWithProducerExtra(fields),right=await positionWithProducerExtra(fields);
  assert.deepEqual(left.extra,right.extra);
  for(const [field,value] of Object.entries(fields))assert.equal(left.extra[field],value);
  const {w,first,second}=ingestReplayPair(left,right);
  assert.equal(first,second);assert.equal(Object.keys(w.jobs).length,1);
  assert.deepEqual(w.jobs[first].canonical.extra,left.extra);
});
const extraReplayRefusals=[
  ['known batch key becomes absent',(left,right)=>{left.extra.batch='批次A';delete right.extra.batch;}],
  ['known batch becomes explicit null',(left,right)=>{left.extra.batch='批次A';right.extra.batch=null;}],
  ['nested extension changes',(left,right)=>{left.extra.futureQualifier={department:'消防组',count:2};right.extra.futureQualifier={department:'机场组',count:2};}],
  ['nested extension becomes missing',(left,right)=>{left.extra.futureQualifier={department:'消防组',count:2};delete right.extra.futureQualifier;}],
  ['extra absent differs from empty object',(left,right)=>{delete left.extra;right.extra={};}],
  ['extra null differs from absent',(left,right)=>{left.extra=null;delete right.extra;}],
];
for(const [label,change] of extraReplayRefusals)test('complete producer extra proof rejects '+label,async()=>{
  const left=await companyUnknownPosition(),right=structuredClone(left);change(left,right);
  assert.deepEqual(jobBusinessContent(left),jobBusinessContent(right));
  const {w,first,second}=ingestReplayPair(left,right);
  assert.notEqual(first,second);assert.equal(Object.keys(w.jobs).length,2);
  assert.deepEqual(w.jobs[first].canonical.extra,left.extra);
});
test('complete extra comparison uses canonical key order without discarding extension values',async()=>{
  const left=await companyUnknownPosition();left.extra.futureQualifier={department:'消防组',count:2};
  const right=structuredClone(left);
  right.extra=Object.fromEntries(Object.entries(right.extra).reverse());
  right.extra.futureQualifier={count:2,department:'消防组'};
  const {w,first,second}=ingestReplayPair(left,right);
  assert.equal(first,second);assert.equal(Object.keys(w.jobs).length,1);
  assert.deepEqual(w.jobs[first].canonical.extra,left.extra);
});