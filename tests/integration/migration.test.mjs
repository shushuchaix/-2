import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {tempRepository} from '../helpers/repository.mjs';import {migrateV1} from '../../src/infrastructure/storage/migrate-v1.mjs';
test('migration backs up, retains ambiguous human state and is idempotent',async t=>{
 const repository=await tempRepository(t),dataDir=repository.dataDir;await fs.mkdir(path.join(dataDir,'runs'));
 const a={id:'old-1',source:'old',title:'Java开发',company:'合成公司',city:'北京',url:'https://jobs.example.com/a',score:70};const b={...a,city:'上海',url:'https://jobs.example.com/b'};
 await fs.writeFile(path.join(dataDir,'job-index.json'),JSON.stringify({version:1,jobs:{'old-1':{...a,status:'applied',note:'已投递，等待回复',firstSeen:'2026-01-01T00:00:00Z'}},runs:[]}));
 await fs.writeFile(path.join(dataDir,'runs','r1.json'),JSON.stringify({runId:'r1',results:[a,b]}));await fs.writeFile(path.join(dataDir,'runs','bad.json'),'{bad');await fs.writeFile(path.join(dataDir,'config.json'),JSON.stringify({apiKey:'SECRET'}));
 const dry=await migrateV1({dataDir,repository,dryRun:true});assert.equal((await repository.read()).revision,0);assert.equal(dry.conflicts.length,1);
 const first=await migrateV1({dataDir,repository});const once=await repository.read();assert.equal(once.applications['legacy:old-1'].note,'已投递，等待回复');assert.equal(first.conflicts.length,1);assert.equal(first.skipped.length,1);assert.equal(once.identityAliases['old-1'].length,2);assert.equal(Object.keys(once.jobs).length,2);
 assert.ok(Object.values(once.evaluations).every(e=>e.status==='legacy'));assert.equal((await fs.readFile(first.manifestPath,'utf8')).includes('SECRET'),false);
 await migrateV1({dataDir,repository});assert.deepEqual(await repository.read(),once);
});
test('empty directories and corrupt legacy index are explicit',async t=>{
 const repository=await tempRepository(t);assert.equal((await migrateV1({repository,dataDir:repository.dataDir})).status,'no_legacy');await fs.writeFile(path.join(repository.dataDir,'job-index.json'),'bad');await assert.rejects(migrateV1({repository,dataDir:repository.dataDir}),/index|corrupt/i);assert.equal((await repository.read()).revision,0);
});
test('activation failure leaves legacy files and the workspace unchanged',async t=>{
 const repository=await tempRepository(t);const raw=JSON.stringify({version:1,jobs:{a:{id:'a',title:'岗位',url:'https://jobs.example.com/1',status:'interested',note:'保留'}}});const p=path.join(repository.dataDir,'job-index.json');await fs.writeFile(p,raw);
 await assert.rejects(migrateV1({dataDir:repository.dataDir,repository:{...repository,mutateWorkspace:async()=>{throw Error('activation failure');}}}),/activation/);assert.equal(await fs.readFile(p,'utf8'),raw);assert.equal((await repository.read()).revision,0);
 const first=await migrateV1({dataDir:repository.dataDir,repository});assert.equal(first.counts.applications,1);assert.equal(Object.values((await repository.read()).applications)[0].note,'保留');
});
