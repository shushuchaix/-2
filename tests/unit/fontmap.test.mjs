import test from 'node:test';
import assert from 'node:assert/strict';
import {learnFromPair,decodeWithMap,coverage} from '../../src/sources/fontmap.mjs';
import {repairTitles} from '../../src/sources/shixiseng.mjs';
test('font learning preserves unknown characters and rejects mismatched alignment',()=>{
  const map=new Map();
  assert.equal(learnFromPair('\ue001\ue002后端','Ja后端',map),2);
  assert.equal(decodeWithMap('\ue001\ue003',map),'J\ue003');
  assert.equal(coverage('\ue001\ue003',map),0.5);
  assert.equal(learnFromPair('\ue005X','aY',map),0);
  assert.equal(map.has('\ue005'),false);
});
test('title repair never transfers a font map between response scopes',async()=>{
 const jobs=[{title:'?',titleRaw:'\ue001岗',titleObfuscated:true,fontScope:'page-a',fontHints:[['\ue001','甲']]},{title:'?',titleRaw:'\ue001岗',titleObfuscated:true,fontScope:'page-b',fontHints:[['\ue001','乙']]}];await repairTitles(jobs,{maxSamples:0,useCache:false});assert.deepEqual(jobs.map(j=>j.title),['甲岗','乙岗']);
});
test('font maps are distinct per response and conflicts remain observable',()=>{
  const pageA=new Map(),pageB=new Map();
  learnFromPair('\ue001','1',pageA);learnFromPair('\ue001','2',pageB);
  assert.equal(decodeWithMap('\ue001',pageA),'1');
  assert.equal(decodeWithMap('\ue001',pageB),'2');
  learnFromPair('\ue001','3',pageA);assert.equal(pageA.__conflicts,1);
});
