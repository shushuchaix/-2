import test from 'node:test';
import assert from 'node:assert/strict';
import official from '../../src/sources/adapters/official-announcements.mjs';
import {loadSiteCatalog} from '../../src/sources/catalog.mjs';
const origin='https://www.zjairports.com';
const listUrl=origin+'/newRecruitment.html';
const apiUrl=origin+'/newRecruitmentPage.html?id=31&pageSize=10&page=2';
const site={siteId:'official-d80ddfbc91795a1f',providerId:'official-announcements',name:'合成机场集团',origin,allowedDomains:['www.zjairports.com'],template:{listUrl,linkRule:'.newsItem02 .cp-block-headline a[href]',bodyRule:'.detailContent',dateRule:null,attachmentRule:'.detailContent a[href]',pathPrefix:'/newRecruitmentInfo.html',nativePagination:'zjairports-options-1',paginationVerified:true}};
test('catalog enables only the evidenced Zhejiang pagination and keeps source readiness unverified',()=>{const entry=loadSiteCatalog().find(x=>x.siteId===site.siteId);assert.equal(entry.template.nativePagination,'zjairports-options-1');assert.equal(entry.template.paginationVerified,true);assert.equal(entry.status,'candidate');assert.equal(entry.verifiedAt,null);});
function rows(start,count){return Array.from({length:count},(_,i)=>`<div class="newsItem02"><div class="cp-block-body"><div class="cp-block-headline"><a href="/newRecruitmentInfo.html?id=${start+i}">合成机场消防招聘${start+i}</a></div><div class="date"><span class="day">13</span><span>2026-10</span></div></div></div>`).join('');}
function context({first=rows(1,10)+`<script>var OPTIONS={id:31,listApiUrl:'/newRecruitmentPage.html',pageSize:10,total:12};</script>`,second=rows(11,2),detail='<h1 class="detailTitle">合成机场消防招聘1</h1><div class="detailContent"><p>合成机场消防招聘，完整工作职责及任职要求正文。报名截至2026年11月30日。</p></div>'}={}){
 const calls=[];return {calls,sites:[site],clock:{now:()=>Date.parse('2026-10-13T12:00:00Z')},signal:new AbortController().signal,request:async(url)=>{calls.push(url);return {url,status:200,text:url===listUrl?first:url===apiUrl?second:detail};}};
}
test('follows the observed native pagination and preserves split publication dates',async()=>{
 const ctx=context();const first=await official.collectPage({site,context:ctx});
 assert.equal(first.records.length,10);assert.equal(first.done,false);assert.equal(first.nextCursor.page,2);assert.equal(first.nextCursor.url,apiUrl);assert.equal(first.records[0].publishedAt,'2026-10-13T00:00:00.000Z');
 const second=await official.collectPage({site,context:ctx,cursor:first.nextCursor});assert.equal(second.records.length,2);assert.equal(second.done,true);assert.equal(second.nextCursor,null);assert.deepEqual(ctx.calls,[listUrl,apiUrl]);
});
test('rejects a foreign or changed native pagination endpoint before reading it',async()=>{
 for(const changed of ["var OPTIONS={id:31,listApiUrl:'https://other.example/list',pageSize:10,total:12};","var OPTIONS={id:32,listApiUrl:'/newRecruitmentPage.html',pageSize:10,total:12};","var OPTIONS={id:31,listApiUrl:'/newRecruitmentPage.html',pageSize:99,total:12};","function neverCalled(){var OPTIONS={id:31,listApiUrl:'/newRecruitmentPage.html',pageSize:10,total:12};}"]){const ctx=context({first:rows(1,10)+'<script>'+changed+'</script>'});await assert.rejects(official.collectPage({site,context:ctx}),e=>e.code==='native_transport_contract_mismatch');assert.deepEqual(ctx.calls,[listUrl]);}
});
test('rejects forged continuation URL or page number before network access',async()=>{
 const ctx=context();await assert.rejects(official.collectPage({site,context:ctx,cursor:{page:2,url:'https://other.example/list',total:12}}),e=>e.code==='collection_cursor_invalid');assert.equal(ctx.calls.length,0);
});
test('binds the notice detail to the exact requested visible title',async()=>{
 const ctx=context({detail:'<h1 class="detailTitle">其他公告</h1><div class="detailContent"><p>其他招聘正文，不能合并给请求的消防招聘公告，报名截至2026年11月30日。</p></div>'});const first=await official.collectPage({site,context:ctx});await assert.rejects(official.fetchDetail(first.records[0],ctx),e=>e.code==='detail_title_mismatch');
});
test('keeps an aggregate notice as a notice and reads its matching complete body',async()=>{
 const ctx=context();const first=await official.collectPage({site,context:ctx});const detail=await official.fetchDetail(first.records[0],ctx);assert.equal(detail.kind,'recruitment_notice');assert.ok(detail.description.includes('完整工作职责'));assert.equal(detail.publishedAt,'2026-10-13T00:00:00.000Z');
});
test('unknown native pagination contract fails explicitly',async()=>{const bad=structuredClone(site);bad.template.nativePagination='unknown';const ctx=context();await assert.rejects(official.collectPage({site:bad,context:ctx}),e=>e.code==='template_not_configured');assert.equal(ctx.calls.length,0);});
test('rejects a foreign detail identity before sending a request',async()=>{
 const ctx=context();const first=await official.collectPage({site,context:ctx});ctx.calls.length=0;
 const record={...first.records[0],url:'https://other.example/newRecruitmentInfo.html?id=1'};
 await assert.rejects(official.fetchDetail(record,ctx),e=>e.code==='detail_identity_mismatch');assert.equal(ctx.calls.length,0);
});
