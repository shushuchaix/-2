import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { collectionFixture } from '../helpers/collection-fixture.mjs';
import { createLegacyProvider } from '../../src/sources/adapters/legacy.mjs';
import { normalizeNowcoderJob,normalizeScheduleItem } from '../../src/sources/nowcoder.mjs';
import { normalizeRecord } from '../../src/domain/record.mjs';
import { readProviderPage } from '../../src/sources/collection-page.mjs';
import { assertJson } from '../../src/infrastructure/storage/sqlite-records.mjs';
import { diagnosticError } from '../../src/infrastructure/diagnostics/log.mjs';

const optionalFields=Object.freeze({refreshTime:'refreshTime',eduLevel:'eduLevelCode',recruitType:'recruitType',companyId:'companyId',avgProcessRate:'avgProcessRate'});
const detailHtml=readFileSync(new URL('../fixtures/nowcoder-detail/443976-reduced.html',import.meta.url),'utf8');
const detailState=JSON.parse(detailHtml.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);\s*<\/script>/)[1]);
function nativeJob(overrides={}){
  return {id:443976,jobName:'合成消防工程师',recommendInternCompany:{companyName:'合成单位'},jobCityList:['北京'],
    refreshTime:1791763200000,eduLevel:5000,recruitType:1,companyId:123,avgProcessRate:90,
    ext:JSON.stringify({infos:'负责消防设施巡检与应急保障。',requirements:'本科及以上学历，消防工程专业。'}),...overrides};
}
const listHtml=jobs=>'<html><body><script>window.__INITIAL_STATE__ = '+JSON.stringify({store:{jobListData:jobs}})+';</script></body></html>';
function nativeDetail(mutate){const copy=structuredClone(detailState);mutate(copy.store.jobDetail.detail);return detailHtml.replace(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?);\s*<\/script>/,'window.__INITIAL_STATE__ = '+JSON.stringify(copy)+';</script>');}
async function fixture(t,html){
  const provider=createLegacyProvider('nowcoder'),calls=[];
  const f=await collectionFixture(t,{providers:[provider],transport:async url=>{calls.push(url);return {status:200,headers:{'content-type':'text/html'},text:html};}});
  assert.equal(await f.repository.getMeta('schemaVersion'),3);
  const ref=await f.service.prepare({scope:f.scope}),site={siteId:'site-0',origin:'https://www.nowcoder.com/jobs/school/jobs'};
  const commit=async(records,ctx)=>{
    for(const record of records)assertJson(record);
    const result=await f.service.commitDiagnosticRecords({ref,token:ctx.token,unitId:'unit-0',records,issues:[],observationKey:'json-'+randomUUID(),operationLease:ctx.operationLease});
    ctx.token.expectedRevision=result.revision;return result;
  };
  const collect=()=>f.service.withDiagnosticContext({ref,requestId:'json-list-'+randomUUID()},async ctx=>{
    const query={keyword:'消防',city:'',pageLimit:1};
    const context={...ctx,config:{},sites:[site],queries:[query],query,targetSnapshot:{cities:[],graduationYear:''}};
    const page=await readProviderPage(provider,{unitId:'unit-0',site,scope:f.scope,ref,token:ctx.token,operationLease:ctx.operationLease,query,signal:ctx.signal,request:ctx.request,context,cursor:null,seenCursorHashes:[]});
    assert.equal(page.records.length,1);assert.deepEqual(page.issues,[]);
    return {record:page.records[0],result:await commit(page.records,ctx)};
  });
  return Object.assign(f,{ref,site,provider,calls,commit,collect});
}
async function assertStored(f,jobId,expectedExtra){
  const saved=await f.repository.read(),job=saved.jobs[jobId],observations=Object.values(saved.observations).filter(o=>o.jobId===jobId);
  assert.ok(job);assert.ok(observations.length);assertJson(job);
  for(const [key,value]of Object.entries(expectedExtra)){assert.deepEqual(job.canonical.extra[key],value);assert.ok(observations.some(o=>(o.fields||o.record).extra[key]===value));}
  for(const observation of observations)assertJson(observation);
  const projection=await f.repository.getRow({collection:'jobProjections',id:jobId,ownerPackageId:f.scope.packageId},{scope:f.scope});assert.ok(projection);assertJson(projection);
  for(const collection of ['jobIdentityKeys','jobFactBasis']){
    const rows=await f.repository.queryRows({collection,ownerPackageId:f.scope.packageId,where:{jobId},limit:100},{scope:f.scope});
    assert.ok(rows.rows.length,collection+' read model must be committed');for(const row of rows.rows)assertJson(row.value);
  }
}
for(const [nativeKey,extraKey]of Object.entries(optionalFields))test('Nowcoder missing '+nativeKey+' survives native list → adapter → schema3 diagnostic commit',async t=>{
  const native=nativeJob();delete native[nativeKey];const f=await fixture(t,listHtml([native]));
  const {record,result}=await f.collect();assert.equal(record.extra[extraKey],null);assert.equal(result.jobIds.length,1);
  await assertStored(f,result.jobIds[0],{[extraKey]:null});assert.equal(f.calls.length,1);
});
test('Nowcoder all missing optional list metadata survives formal commit and reopen',async t=>{
  const native=nativeJob();for(const key of Object.keys(optionalFields))delete native[key];const f=await fixture(t,listHtml([native]));
  const {result}=await f.collect(),expected=Object.fromEntries(Object.values(optionalFields).map(key=>[key,null]));
  await assertStored(f,result.jobIds[0],expected);await f.reopen();await assertStored(f,result.jobIds[0],expected);assert.equal(f.calls.length,1);
});
test('Nowcoder explicit zero metadata stays zero through formal store',async t=>{
  const native=nativeJob(Object.fromEntries(Object.keys(optionalFields).map(key=>[key,0]))),f=await fixture(t,listHtml([native]));
  const {result}=await f.collect();await assertStored(f,result.jobIds[0],Object.fromEntries(Object.values(optionalFields).map(key=>[key,0])));
});
test('Nowcoder supplied optional metadata remains unchanged through formal store',async t=>{
  const native=nativeJob(),f=await fixture(t,listHtml([native])),{result}=await f.collect();
  await assertStored(f,result.jobIds[0],Object.fromEntries(Object.entries(optionalFields).map(([from,to])=>[to,native[from]])));
});
for(const [name,status,expected]of [['missing',undefined,null],['zero',0,0]])test('Nowcoder native detail '+name+' status survives schema3 store without inheriting undefined',async t=>{
  const html=nativeDetail(native=>{if(status===undefined)delete native.status;else native.status=status;}),f=await fixture(t,html);
  const native=nativeJob();for(const key of Object.keys(optionalFields))delete native[key];
  const seed=normalizeRecord({...normalizeNowcoderJob(native),sourceId:'nowcoder',siteId:f.site.siteId,identityScope:f.site.siteId,sourceRecordIdKind:'authority',urlKind:'job_detail'});
  const result=await f.service.withDiagnosticContext({ref:f.ref,requestId:'json-detail-'+randomUUID()},async ctx=>{
    const detail=await f.provider.fetchDetail(seed,{...ctx,request:ctx.request});assert.equal(detail.bodyStatus,'complete');assert.equal(detail.extra.nativeStatus,expected);assert.match(detail.description,/消防设备巡检/);
    return f.commit([detail],ctx);
  });
  await assertStored(f,result.jobIds[0],{nativeStatus:expected,refreshTime:null,companyId:null});assert.equal(f.calls.length,1);
});
test('Nowcoder optional schedule update time uses null and retains zero',async t=>{
  const f=await fixture(t,''),native={name:'合成消防企业',companyId:123,cityList:['北京']};
  const record=normalizeRecord({...normalizeScheduleItem(native),sourceId:'nowcoder',siteId:f.site.siteId,identityScope:f.site.siteId});
  assert.equal(record.extra.updateTime,null);assert.equal(normalizeScheduleItem({...native,updateTime:0}).extra.updateTime,0);
  const result=await f.service.withDiagnosticContext({ref:f.ref,requestId:'json-schedule-'+randomUUID()},ctx=>f.commit([record],ctx));
  await assertStored(f,result.jobIds[0],{updateTime:null});assert.equal(f.calls.length,0);
});
for(const [name,value]of [['undefined',undefined],['Date',new Date('2026-10-01T00:00:00Z')],['BigInt',1n],['sparse array',Array(1)]])test('Strict store still rejects nested '+name+' and rolls back all rows',async t=>{
  const f=await fixture(t,''),prefix='json-bad-'+randomUUID(),ids=[prefix+'-good',prefix+'-bad'];
  const selection={select:[{collection:'settings',ids}]},revision=await f.repository.getMeta('revision');
  await assert.rejects(f.repository.transaction(selection,tx=>{tx.putRow({collection:'settings',id:ids[0],value:{value:'kept only if committed'}});tx.putRow({collection:'settings',id:ids[1],value:{extra:{value}}});}),{code:'sqlite_invalid_json'});
  assert.equal(await f.repository.getMeta('revision'),revision);for(const id of ids)assert.equal(await f.repository.getRow({collection:'settings',id}),null);
});
test('Formal diagnostic commit with one invalid nested value leaves no partial jobs or observations',async t=>{
  const f=await fixture(t,''),make=(id,title)=>normalizeRecord({...normalizeNowcoderJob(nativeJob({id,jobName:title})),sourceId:'nowcoder',siteId:f.site.siteId,identityScope:f.site.siteId,sourceRecordIdKind:'authority',urlKind:'job_detail'});
  const good=make(443976,'合成消防工程师'),bad=make(443977,'合成机场消防工程师');bad.extra.invalid=undefined;
  await assert.rejects(f.service.withDiagnosticContext({ref:f.ref,requestId:'invalid-batch-'+randomUUID()},ctx=>f.service.commitDiagnosticRecords({ref:f.ref,token:ctx.token,unitId:'unit-0',records:[good,bad],issues:[],observationKey:'invalid-batch',operationLease:ctx.operationLease})),{code:'sqlite_invalid_json'});
  const saved=await f.repository.read();for(const collection of ['jobs','observations'])assert.equal(Object.keys(saved[collection]||{}).length,0);
  for(const collection of ['jobProjections','jobIdentityKeys','jobFactBasis'])assert.equal((await f.repository.queryRows({collection,ownerPackageId:f.scope.packageId,limit:100},{scope:f.scope})).rows.length,0);
});
test('Formal diagnostic metadata retains sqlite_invalid_json without copying private error text',()=>{
  const error=Object.assign(new Error('PRIVATE_SYNTHETIC_MESSAGE'),{code:'sqlite_invalid_json'}),safe=diagnosticError(error);
  assert.equal(safe.code,'sqlite_invalid_json');assert.doesNotMatch(JSON.stringify(safe),/PRIVATE_SYNTHETIC_MESSAGE/);
});
