import test from 'node:test';
import assert from 'node:assert/strict';
import {readProviderPage} from '../../src/sources/collection-page.mjs';
import {createPagedProvider,baseRecord} from '../../src/sources/adapters/shared.mjs';
import greenhouse,{greenhouseListUrl} from '../../src/sources/adapters/greenhouse.mjs';

// All requests/authority/cache ports below are synthetic. No runtime or network.
const site={siteId:'synthetic-board',providerId:'greenhouse',tenantId:'synthetic',name:'合成单位'};
const scope={packageId:'synthetic-package',targetRevisionId:'synthetic-revision'};
const mode='single-public-get-v2';
const record=(title='合成消防岗位',extra={})=>baseRecord({id:'1',sourceId:'synthetic',siteId:site.siteId,title,
  url:'https://jobs.example.org/jobs/1',description:'消防工程职责和资格要求仅用于本地合成测试。',...extra});
function memoryCache() {
  const values=new Map(),gets=[],puts=[];
  return {values,gets,puts,
    async get({resourceKey}){gets.push(resourceKey);return structuredClone(values.get(resourceKey)||null);},
    async put(input){puts.push(structuredClone(input));values.set(input.resourceKey,structuredClone(input));},
  };
}
function input(cache,request,extra={}) {
  return {site,scope,ref:{scope,activityId:'synthetic-activity'},token:{epoch:1,sliceRunId:'synthetic-slice'},
    operationLease:{operationId:'synthetic-operation',token:'synthetic-token'},cursor:null,query:{keyword:'消防'},
    context:{conditionalCache:cache,clock:{now:()=>Date.parse('2026-10-21T00:00:00Z')}},request,...extra};
}
function synthetic(listPage,extra={}) {
  return createPagedProvider({id:'synthetic',name:'合成来源',parserVersion:'synthetic-2',conditionalPageCache:mode,
    listPage,capabilities:{},...extra});
}
const ghRows=[
  ['1','消防设施工程师','维护消防设施'],['2','机场工程师','机场运行'],
  ['3','消防机场工程师','机场消防培训'],['4','其它工程师','设备设计'],
].map(([id,title,body])=>({id,title,content:'<p>'+body+'</p>',absolute_url:'https://job-boards.greenhouse.io/synthetic/jobs/'+id}));

for(const terms of [['消防','机场'],['机场','消防']])test(`Greenhouse fixed URL filters each query independently (${terms.join(' then ')})`,async()=>{
  const cache=memoryCache(),calls=[];let now=Date.parse('2026-10-21T00:00:00Z');
  const request=async(url,options={})=>{
    calls.push({url,options});assert.equal(url,greenhouseListUrl(site));
    return options.headers?.['If-None-Match']?{status:304,headers:{},url,text:''}:
      {status:200,headers:{etag:'"all-four"'},url,text:JSON.stringify({jobs:ghRows,meta:{total:4}})};
  };
  const read=term=>readProviderPage(greenhouse,input(cache,request,{query:{keyword:term},context:{conditionalCache:cache,clock:{now:()=>now}}}));
  const first=await read(terms[0]);now+=1000;const second=await read(terms[1]);now+=1000;
  const third=await read(terms[0]);
  const ids=term=>term==='消防'?['1','3']:['2','3'];
  assert.deepEqual(first.records.map(r=>r.sourceRecordId),ids(terms[0]));
  assert.deepEqual(second.records.map(r=>r.sourceRecordId),ids(terms[1]));
  assert.deepEqual(third.records.map(r=>r.sourceRecordId),ids(terms[0]));
  assert.equal(second.notModified,undefined);assert.equal(third.notModified,true);
  assert.equal(third.reusedEvidence,true);assert.equal(third.stats.raw,4);
  assert.equal(calls.length,3);assert.equal(calls[0].options.headers?.['If-None-Match'],undefined);
  assert.equal(calls[1].options.headers?.['If-None-Match'],undefined);assert.equal(calls[2].options.headers['If-None-Match'],'"all-four"');
  assert.equal(third.conditionalResponse.evidenceCheckedAt,first.conditionalResponse.evidenceCheckedAt);
  assert.notEqual(third.conditionalResponse.checkedAt,third.conditionalResponse.evidenceCheckedAt);
  assert.equal(cache.values.size,2);assert.equal(greenhouse.parserVersion,'greenhouse-job-board-2');
});

test('v2 query keys are deterministic and site/cursor/parser changes isolate evidence',async()=>{
  const cache=memoryCache(),calls=[];
  const provider=synthetic(async(_site,_query,_page,ctx)=>{await ctx.request('https://jobs.example.org/list');return {records:[record()],hasMore:false};});
  const request=async(_url,options={})=>{calls.push(options);return options.headers?.['If-None-Match']?
    {status:304,headers:{},text:''}:{status:200,headers:{etag:'"one"'},text:'public'};};
  const read=(p,extra)=>readProviderPage(p,input(cache,request,extra));
  await read(provider,{query:{keyword:'private-synthetic-canary',city:'合成市'}});
  const reordered=await read(provider,{query:{city:'合成市',keyword:'private-synthetic-canary'}});
  assert.equal(reordered.notModified,true);
  for(const change of [{site:{...site,siteId:'other-site'},query:{keyword:'private-synthetic-canary',city:'合成市'}},
    {cursor:{page:2},query:{keyword:'private-synthetic-canary',city:'合成市'}},
    {query:{keyword:'another-synthetic-canary',city:'合成市'}}]) {
    const changed=await read(provider,change);assert.equal(changed.notModified,undefined);
  }
  const revised=synthetic(async(_s,_q,_p,ctx)=>{await ctx.request('https://jobs.example.org/list');return {records:[record()],hasMore:false};},{parserVersion:'synthetic-3'});
  assert.equal((await read(revised,{query:{keyword:'private-synthetic-canary',city:'合成市'}})).notModified,undefined);
  assert.equal(calls.filter(o=>o.headers?.['If-None-Match']).length,1);
  assert.ok(cache.puts.every(p=>/^page:v2:[a-f0-9]{64}$/.test(p.resourceKey)));
  assert.equal(JSON.stringify(cache.puts).includes('private-synthetic-canary'),false);
  assert.equal(JSON.stringify(cache.puts).includes('another-synthetic-canary'),false);
});

test('Greenhouse same site and URL with changed public employer name fetches and normalizes fresh company',async()=>{
  const cache=memoryCache(),calls=[];
  const request=async(url,options={})=>{calls.push(options);return options.headers?.['If-None-Match']?{status:304,url,headers:{},text:''}:
    {status:200,url,headers:{etag:'"same-board-body"'},text:JSON.stringify({jobs:ghRows,meta:{total:4}})};};
  const old=await readProviderPage(greenhouse,input(cache,request,{site:{...site,name:'旧合成雇主'}}));
  const changed=await readProviderPage(greenhouse,input(cache,request,{site:{...site,name:'新合成雇主'}}));
  assert.equal(old.records[0].company,'旧合成雇主');assert.equal(changed.records[0].company,'新合成雇主');
  assert.equal(changed.notModified,undefined);assert.equal(calls[1].headers?.['If-None-Match'],undefined);assert.equal(cache.values.size,2);
});

test('default providers never conditionally restore or persist whole pages',async()=>{
  const cache=memoryCache();let calls=0;
  const provider=createPagedProvider({id:'synthetic',name:'default',listPage:async(_s,_q,_p,ctx)=>{
    await ctx.request('https://jobs.example.org/list');return {records:[record()],hasMore:false};}});
  const request=async(_url,options={})=>{calls++;assert.equal(options.headers?.['If-None-Match'],undefined);return {status:200,headers:{etag:'x'},text:'public'};};
  await readProviderPage(provider,input(cache,request));await readProviderPage(provider,input(cache,request));
  assert.equal(calls,2);assert.equal(cache.gets.length,0);assert.equal(cache.puts.length,0);
});

test('matching parser without v2 single-resource proof cannot restore a legacy entry',async()=>{
  const cache=memoryCache(),calls=[];
  const provider=synthetic(async(_s,_q,_p,ctx)=>{const r=await ctx.request('https://jobs.example.org/list');assert.equal(r.status,200);return {records:[record('fresh')],hasMore:false};});
  cache.get=async({resourceKey})=>{cache.gets.push(resourceKey);return {parserVersion:provider.parserVersion,etag:'"old"',
    bodyHash:'a'.repeat(64),parsedEvidence:{pageResult:{parserVersion:provider.parserVersion,records:[record('stale')],done:true}}};};
  const result=await readProviderPage(provider,input(cache,async(_url,options={})=>{
    calls.push(options);return {status:200,headers:{etag:'"new"'},text:'new body'};
  }));
  assert.equal(result.records[0].title,'fresh');assert.equal(calls[0].headers?.['If-None-Match'],undefined);
  assert.equal(result.notModified,undefined);assert.equal(cache.puts[0].parsedEvidence.cacheEvidence.version,2);
});

for(const methods of [['GET','GET'],['GET','POST'],['POST','GET']])test(`misdeclared opt-in ${methods.join('+')} never persists a whole page`,async()=>{
  const cache=memoryCache();let calls=0;
  const provider=synthetic(async(_s,_q,_p,ctx)=>{
    for(const [index,method] of methods.entries())await ctx.request('https://jobs.example.org/resource/'+index,{method,...(method==='POST'?{body:'synthetic'}:{})});
    return {records:[record('round-'+calls)],hasMore:false};
  });
  const request=async(_url,options={})=>{calls++;assert.equal(options.headers?.['If-None-Match'],undefined);return {status:200,headers:{etag:'"unchanged-config"'},text:'public'};};
  const first=await readProviderPage(provider,input(cache,request)),second=await readProviderPage(provider,input(cache,request));
  assert.equal(calls,4);assert.equal(first.conditionalResponse,undefined);assert.equal(second.conditionalResponse,undefined);
  assert.notEqual(first.records[0].title,second.records[0].title);assert.equal(cache.puts.length,0);
});

test('changed first resource plus unsolicited second-resource 304 cannot restore an old multi-resource page',async()=>{
  const cache=memoryCache();let calls=0;
  const provider=synthetic(async(_s,_q,_p,ctx)=>{
    const a=await ctx.request('https://jobs.example.org/a'),b=await ctx.request('https://jobs.example.org/b');
    if(a.status!==200||b.status!==200)throw Object.assign(Error('synthetic missing body'),{code:'parse_error'});
    return {records:[record(a.text+b.text)],hasMore:false};
  });
  const request=async()=>{calls++;return {status:calls===4?304:200,headers:{etag:'"b-stable"'},text:'resource-'+calls};};
  assert.equal((await readProviderPage(provider,input(cache,request))).records[0].title,'resource-1resource-2');
  await assert.rejects(readProviderPage(provider,input(cache,request)),{code:'parse_error'});
  assert.equal(calls,4);assert.equal(cache.puts.length,0);
});

for(const options of [{method:'POST',body:'synthetic'},{body:'synthetic'},{headers:{Authorization:'synthetic-only'}},
  {headers:{Cookie:'synthetic-only'}},{headers:{'Proxy-Authorization':'synthetic-only'}},{headers:{'X-Api-Key':'synthetic-only'}}])
test(`credential/body request cannot persist parsed pages (${JSON.stringify(Object.keys(options))})`,async()=>{
  const cache=memoryCache();
  const provider=synthetic(async(_s,_q,_p,ctx)=>{await ctx.request('https://jobs.example.org/list',options);return {records:[record()],hasMore:false};});
  await readProviderPage(provider,input(cache,async()=>({status:200,headers:{etag:'x'},text:'public'})));
  assert.equal(cache.gets.length,0);assert.equal(cache.puts.length,0);
});

for(const secondStatus of [200,304])test(`unsolicited 304 fetches a body only once (${secondStatus})`,async()=>{
  const cache=memoryCache();let calls=0;
  const provider=synthetic(async(_s,_q,_p,ctx)=>{
    const response=await ctx.request('https://jobs.example.org/list',{headers:{'If-None-Match':'external-condition'}});
    if(response.status!==200)throw Object.assign(Error('synthetic missing body'),{code:'parse_error'});
    return {records:[record()],hasMore:false};
  });
  const request=async(_url,options={})=>{
    if(++calls===2)assert.equal(Object.keys(options.headers).some(k=>/if-none-match|if-modified-since/i.test(k)),false);
    return {status:calls===1?304:secondStatus,headers:{etag:'x'},text:secondStatus===200?'public':''};
  };
  if(secondStatus===200)assert.equal((await readProviderPage(provider,input(cache,request))).records.length,1);
  else await assert.rejects(readProviderPage(provider,input(cache,request)),{code:'parse_error'});
  assert.equal(calls,2);assert.equal(cache.puts.length,0);
});

test('oversized parsed evidence remains uncached without raising the one MiB limit',async()=>{
  const cache=memoryCache(),provider=synthetic(async(_s,_q,_p,ctx)=>{
    await ctx.request('https://jobs.example.org/list');return {records:[record('large',{description:'x'.repeat(1024*1024)})],hasMore:false};
  });
  assert.equal((await readProviderPage(provider,input(cache,async()=>({status:200,headers:{etag:'x'},text:'public'})))).records.length,1);
  assert.equal(cache.puts.length,0);
});

test('cache read/write and cancelled request errors preserve identity and stop subsequent work',async()=>{
  const provider=synthetic(async(_s,_q,_p,ctx)=>{await ctx.request('https://jobs.example.org/list');return {records:[record()],hasMore:false};});
  for(const phase of ['get','request','put']){
    const cache=memoryCache(),error=Object.assign(Error('synthetic storage'),{code:'sqlite_constraint',runFatal:true});let transports=0;
    if(phase!=='request')cache[phase]=async()=>{throw error;};
    await assert.rejects(readProviderPage(provider,input(cache,async()=>{transports++;if(phase==='request')throw error;return {status:200,headers:{etag:'x'},text:'public'};})),e=>e===error);
    assert.equal(transports,phase==='get'?0:1);
  }
  const cache=memoryCache(),controller=new AbortController(),abort=Object.assign(Error('synthetic cancellation'),{name:'AbortError'});let calls=0;
  await assert.rejects(readProviderPage(provider,input(cache,async()=>{calls++;controller.abort(abort);return {status:200,headers:{etag:'x'},text:'public'};},{signal:controller.signal})),e=>e===abort);
  assert.equal(calls,1);assert.equal(cache.puts.length,0);
});
