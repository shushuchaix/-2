import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { collectionFixture } from '../helpers/collection-fixture.mjs';
import { packageBusinessFixture } from '../helpers/package-business-fixture.mjs';
import { createPagedProvider } from '../../src/sources/adapters/shared.mjs';
import { createEvaluationService } from '../../src/application/evaluation-service.mjs';
import announcements from '../../src/sources/adapters/official-announcements.mjs';
import { loadSiteCatalog } from '../../src/sources/catalog.mjs';
import { job } from '../helpers/fixtures.mjs';

const publicText='消防岗位：本科消防工程专业，负责消防设施检查和消防应急演练。';
test('real production collection expands public notice to owned jobs then real local rules evaluates without another model call', {timeout:120000},async t=>{
  let calls=0,sourceReads=0;const sent=[];
  const provider=createPagedProvider({id:'synthetic',name:'synthetic',capabilities:{},listPage:async()=>{
    sourceReads++;return {records:[job({sourceId:'synthetic',siteId:'site-0',identityScope:'site-0',sourceRecordId:'notice-live',
      kind:'recruitment_notice',title:'合成消防招聘公告',description:publicText,bodyStatus:'complete',intent:'employer_recruitment',
      profile:{private:'PRIVATE_PROFILE_CANARY'},target:{name:'PRIVATE_VERSION_CANARY'}})],hasMore:false};}});
  const f=await collectionFixture(t,{providers:[provider],modelFactory:()=>({chatJson:async(system,user)=>{
    calls++;sent.push(system+user);return {isRecruiting:true,positions:[{title:'消防岗位',education:'本科',major:'消防工程',requirementsExcerpt:'本科消防工程专业，负责消防设施检查和消防应急演练。'}]};
  }})});
  const started=await f.service.start({scope:f.scope,options:{mode:'ai'}}),ref={scope:f.scope,activityId:started.activityId};
  await f.service.wait(ref);
  const page=await f.jobs.queryJobs({...f.scope}),derived=page.items.filter(item=>item.kind==='job');
  assert.equal(sourceReads,1);assert.equal(calls,1);assert.equal(derived.length,1);assert.equal(page.items.filter(item=>item.kind==='recruitment_notice').length,1);
  assert.equal(derived[0].derivedFrom,'notice-live');assert.equal(sent.some(text=>text.includes('CANARY')||text.includes('合成测试简历')),false);
  const evaluator=createEvaluationService({repository:f.repository,operationGate:f.operationGate});
  const result=await evaluator.evaluate({scope:f.scope,jobIds:[derived[0].jobId],mode:'rules'});
  assert.equal(result.evaluations.length,1);assert.equal(result.evaluations[0].status,'rules');assert.equal(calls,1);
  const count=page.total,[again]=await f.ingest(f.scope,[derived[0].fact.record]);
  assert.equal(again,derived[0].jobId);assert.equal((await f.jobs.queryJobs({...f.scope})).total,count);
  assert.equal((await f.jobs.queryJobs({...f.otherScope})).total,0);
});

test('GST public row email candidates survive parser, version-scoped persistence, export and same-row revocation', {timeout:120000},async t=>{
  const html=await fs.readFile(new URL('../fixtures/official-template-repair/gst-inline.html',import.meta.url),'utf8');
  const site=loadSiteCatalog().find(s=>s.siteId==='official-9b7b3076410fcacc'),requests=[];
  const response=await announcements.collectPage({site,context:{clock:{now:()=>Date.parse('2026-10-27T00:00:00Z')},request:async url=>{
    requests.push(url);return {status:200,url,text:html.replaceAll('fixture@example.invalid','=cmd@example.invalid')};
  }}});
  assert.equal(requests.length,1);assert.equal(response.records.length,3);
  const record=response.records[0];assert.equal(record.applicationChannels.length,1);assert.equal(record.applicationChannels[0].binding.nativeJobId,record.sourceRecordId);
  assert.equal(record.applicationChannels[0].address,'=cmd@example.invalid');
  const f=await packageBusinessFixture(t),{a,b}=await f.twoTargets(),[ja]=await f.ingest(a,[record]),[jb]=await f.ingest(b,[record]);
  assert.notEqual(ja,jb);
  const detail=await f.jobs.getJob(ja,a);assert.equal(detail.fact.record.applicationChannels[0].address,'=cmd@example.invalid');
  assert.equal(detail.recruitmentEvidence.applicationStatus,'unknown');
  const json=JSON.parse((await f.exportService.export({scope:a})).body);assert.equal(json[0].applicationChannels[0].deliveryVerified,false);
  const csv=await f.exportService.export({format:'csv',scope:a});assert.ok(csv.body.includes("'=cmd@example.invalid"));
  assert.ok(csv.body.includes('未证明邮箱实际收件或已经提交'));
  const markdown=await f.exportService.export({format:'markdown',scope:a});assert.ok(markdown.body.includes('官方邮件渠道候选'));
  await f.ingest(a,[{...record,applicationChannels:[]}]);
  assert.deepEqual((await f.jobs.getJob(ja,a)).fact.record.applicationChannels,[]);
  assert.equal((await f.jobs.getJob(jb,b)).fact.record.applicationChannels.length,1);
  const hidden=html.replaceAll('class="career-meta-row"><span class="career-meta-label">简历投递邮箱','hidden class="career-meta-row"><span class="career-meta-label">简历投递邮箱');
  const noContact=await announcements.collectPage({site,context:{request:async url=>({status:200,url,text:hidden})}});
  assert.equal(noContact.records[0].applicationChannels.length,0);
});
// R3: source-only HTML fixtures. No browser/CSS execution and no actual network.
const emailMeta='<div class="career-meta-row"><span class="career-meta-label">简历投递邮箱</span><span class="career-meta-value"><a class="career-mailto" href="mailto:fixture@example.invalid">合成邮箱</a></span></div>';
const rejectedEmailInstructions=[
  ['hidden-only label',emailMeta.replace('简历投递邮箱','<span hidden>简历投递邮箱</span>')],
  ['visible contact with hidden application label',emailMeta.replace('简历投递邮箱','联系邮箱<span aria-hidden="true">简历投递邮箱</span>')],
  ['anchor outside the labeled value',emailMeta.replace('<span class="career-meta-value">','').replace('</a></span>','</a><span class="career-meta-value"></span>')],
];
for(const [label,replacement] of rejectedEmailInstructions)test('GST rejects email candidate for '+label,async()=>{
  const html=await fs.readFile(new URL('../fixtures/official-template-repair/gst-inline.html',import.meta.url),'utf8');
  assert.ok(html.includes(emailMeta));
  const site=loadSiteCatalog().find(s=>s.siteId==='official-9b7b3076410fcacc');let requests=0;
  const response=await announcements.collectPage({site,context:{clock:{now:()=>new Date('2026-10-27T00:00:00Z')},request:async url=>{
    requests++;return {status:200,url,text:html.replaceAll(emailMeta,replacement)};
  }}});
  assert.equal(requests,1);assert.equal(response.records.length,3);
  assert.deepEqual(response.records[0].applicationChannels,[]);
  assert.deepEqual(response.records[1].applicationChannels,[]);
  // The unrelated English row keeps its own genuine visible directive.
  assert.equal(response.records[2].applicationChannels.length,1);
  assert.equal(response.records[2].applicationChannels[0].binding.nativeJobId,response.records[2].sourceRecordId);
  assert.equal(response.records[2].applicationChannels[0].status,'candidate');
  assert.equal(response.records[2].applicationChannels[0].deliveryVerified,false);
});
test('two real collection runs persist one company-unknown derived job, retain both article caches, and stay version isolated after reopen', {timeout:120000},async t=>{
  let sourceReads=0,modelCalls=0;
  const provider=createPagedProvider({id:'synthetic',name:'synthetic',capabilities:{},listPage:async()=>{
    sourceReads++;return {records:[job({sourceId:'synthetic',siteId:'site-0',identityScope:'site-0',sourceRecordId:'notice-repeated',
      kind:'recruitment_notice',title:'合成消防招聘公告',description:publicText,bodyStatus:'complete',intent:'employer_recruitment'})],hasMore:false};
  }});
  const f=await collectionFixture(t,{providers:[provider],modelFactory:()=>({chatJson:async()=>{
    modelCalls++;return {isRecruiting:true,positions:[{title:'消防岗位',education:'本科',major:'消防工程',
      requirementsExcerpt:'本科消防工程专业，负责消防设施检查和消防应急演练。'}]};
  }})});
  const first=await f.service.start({scope:f.scope,options:{mode:'ai',requestId:'replay-first'}}),firstRef={scope:f.scope,activityId:first.activityId};
  await f.service.wait(firstRef);
  const before=await f.jobs.queryJobs({...f.scope}),firstPosition=before.items.find(item=>item.kind==='job');
  assert.ok(firstPosition);assert.equal(firstPosition.fact.record.company,null);assert.equal(before.total,2);
  await f.reopen();
  const second=await f.service.start({scope:f.scope,options:{mode:'ai',requestId:'replay-second'}}),secondRef={scope:f.scope,activityId:second.activityId};
  assert.notEqual(second.activityId,first.activityId);
  await f.service.wait(secondRef);
  const after=await f.jobs.queryJobs({...f.scope}),positions=after.items.filter(item=>item.kind==='job');
  assert.equal(sourceReads,2);assert.equal(modelCalls,2);assert.equal(after.total,before.total);
  assert.equal(positions.length,1);assert.equal(positions[0].jobId,firstPosition.jobId);
  assert.equal(positions[0].fact.record.sourceRecordIdKind,'generated');
  assert.equal(positions[0].fact.record.company,null);
  for(const ref of [firstRef,secondRef]){
    const cache=await f.repository.queryRows({collection:'articleCache',ownerPackageId:f.scope.packageId,
      where:{parentId:ref.activityId,path:'collectionProgress.articleCache'},limit:10,total:false},{scope:f.scope});
    assert.equal(cache.rows.length,1);assert.equal(cache.rows[0].value.record.sourceRecordId,'notice-repeated');
    assert.equal((await f.service.get(ref)).collectionProgress.status,'completed');
  }
  assert.equal((await f.jobs.queryJobs({...f.otherScope})).total,0);
  const [otherId]=await f.ingest(f.otherScope,[positions[0].fact.record]);
  assert.notEqual(otherId,firstPosition.jobId);
  assert.equal((await f.jobs.queryJobs({...f.otherScope})).total,1);
  assert.equal((await f.jobs.queryJobs({...f.scope})).total,2);
});