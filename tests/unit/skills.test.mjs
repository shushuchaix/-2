import test from 'node:test';
import assert from 'node:assert/strict';
import {matchedKeywords} from '../../src/match/score.mjs';
test('legacy keywords do not match JavaScript CAD or CET as Java and C',()=>{
  assert.deepEqual(matchedKeywords({title:'JavaScript开发',description:'CAD CET'},['Java','C']),[]);
  assert.deepEqual(matchedKeywords({title:'熟悉Java与C++开发'},['Java','C++']),['Java','C++']);
});
test('ontology separates explicit skill evidence aliases related skills and major families',async()=>{
  const {findSkillEvidence,majorRoleFit}=await import('../../src/domain/skills.mjs');
  assert.deepEqual(findSkillEvidence('JavaScript CAD CET',['java','c']),[]);
  assert.deepEqual(findSkillEvidence('熟悉Java与C++开发',['java','cpp']).map(x=>x.skillId),['java','cpp']);
  assert.equal(findSkillEvidence('Spring',['java']).some(x=>x.relation==='exact'),false);
  assert.equal(findSkillEvidence('JS开发',['javascript'])[0].relation,'alias');
  assert.equal(majorRoleFit({major:'消防工程'},{title:'网络安全工程师',description:'渗透测试 SIEM'}).status,'mismatch');
  assert.equal(majorRoleFit({major:'消防工程'},{title:'消防设施维护工程师',description:'消防设施维护'}).status,'matched');
});
