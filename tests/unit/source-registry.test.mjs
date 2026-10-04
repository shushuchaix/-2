import test from 'node:test';import assert from 'node:assert/strict';import {createSourceRegistry} from '../../src/sources/registry.mjs';
const provider={id:'test',name:'测试',capabilities:{},configSchema:{},collect:async()=>{},fetchDetail:async()=>{},probe:async()=>{}};
test('registration rejects duplicates and incomplete capabilities',()=>{assert.throws(()=>createSourceRegistry([provider,provider]),/duplicate/i);assert.throws(()=>createSourceRegistry([{id:'bad'}]),/contract/i);const r=createSourceRegistry([provider]);assert.equal(r.get('test'),provider);assert.equal(r.list().length,1);});
