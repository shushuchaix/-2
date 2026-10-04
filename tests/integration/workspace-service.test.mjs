import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {tempRepository} from '../helpers/repository.mjs';import {createWorkspaceService} from '../../src/application/workspace-service.mjs';import {loadConfig,DEFAULT_CONFIG} from '../../src/config.mjs';
test('profile and target revisions are immutable and references prevent deletion',async t=>{
 const repository=await tempRepository(t);const s=createWorkspaceService({repository});
 const a=await s.saveProfile({text:'合成简历',profile:{major:'消防工程',cities:['北京']},overrides:{major:'安全工程'}});const b=await s.saveProfile({profileId:a.profileId,text:'更新',profile:{major:'软件工程'}});
 assert.notEqual(a.revisionId,b.revisionId);assert.equal((await s.getProfileRevision(a.revisionId)).text,'合成简历');assert.equal(a.profile.major,'安全工程');
 const target=await s.saveTarget({profileRevisionId:a.revisionId,roles:['安全工程师'],cityMode:'any',cities:[],enabled:false});assert.equal(target.enabled,false);assert.equal(target.profileRevisionId,a.revisionId);await assert.rejects(s.deleteProfileRevision(a.revisionId),/referenced/i);await assert.rejects(s.saveTarget({profileRevisionId:'absent@1',roles:['岗位']}),/profile/i);
 assert.equal((await s.saveTarget({profileRevisionId:b.revisionId,roles:['岗位'],cities:null})).cityMode,'from_profile');assert.equal((await s.saveTarget({profileRevisionId:b.revisionId,roles:['岗位'],cities:['上海']})).cityMode,'selected');
});
test('configuration reads new seeds immediately and never mutates defaults',async t=>{
 const repo=await tempRepository(t);const first=loadConfig({quiet:true,dataDir:repo.dataDir});first.sources.zhaopin.enabled=false;first.deepseek.apiKey='mutation';assert.equal(DEFAULT_CONFIG.sources.zhaopin.enabled,true);assert.equal(DEFAULT_CONFIG.deepseek.apiKey,'');
 await fs.writeFile(path.join(repo.dataDir,'config.json'),JSON.stringify({sources:{zhaopin:{enabled:false}},server:{port:9876}}));const seeded=loadConfig({quiet:true,dataDir:repo.dataDir});assert.equal(seeded.server.port,9876);assert.equal(seeded.sources.zhaopin.enabled,false);assert.equal(loadConfig({quiet:true,dataDir:repo.dataDir}).server.port,9876);
});
