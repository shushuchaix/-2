import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createTempDir,registerTestResource } from '../helpers/fixtures.mjs';
import { openWorkspaceRepository } from '../../src/infrastructure/storage/repository.mjs';
import { createApplicationContext } from '../../src/application/context.mjs';
import { createModelCredentialBinding } from '../../src/application/model-credential-binding.mjs';
import { DEFAULT_CONFIG } from '../../src/config.mjs';
import { createSourceRegistry } from '../../src/sources/registry.mjs';
import { createCredentialService,registerCredentialIpc } from '../../electron/credentials.mjs';
import { createModelCredentialHandler } from '../../electron/backend/service.mjs';

const fakeSafeStorage={isEncryptionAvailable:()=>true,
  encryptString:key=>Buffer.from('synthetic-encrypted:'+key).reverse(),
  decryptString:value=>Buffer.from(value).reverse().toString().slice('synthetic-encrypted:'.length)};

async function fixture(t,{seed=true}={}){
  const dataDir=await createTempDir(t),cfg=structuredClone(DEFAULT_CONFIG);
  cfg.deepseek.apiKey='synthetic-before-crash';
  if(seed){
    const repository=await openWorkspaceRepository({dataDir});
    try{await repository.transaction({select:[{collection:'settings',ids:['model','apiKeyBinding']}]},tx=>{
      tx.putRow({collection:'settings',id:'model',value:{baseUrl:cfg.deepseek.baseUrl,model:cfg.deepseek.model}});
      tx.putRow({collection:'settings',id:'apiKeyBinding',value:createModelCredentialBinding(cfg.deepseek.apiKey,cfg.deepseek)});
    });}finally{await repository.close();}
  }
  const dependencies={startScheduler:false,registry:createSourceRegistry([]),catalog:[]};
  const open=async(candidate=cfg.deepseek.apiKey,extra={})=>{
    const runtime=structuredClone(DEFAULT_CONFIG);runtime.deepseek.apiKey=candidate;
    const context=await createApplicationContext({cfg:runtime,dataDir,dependencies:{...dependencies,...extra}});
    registerTestResource(t,()=>context.close());return {context,cfg:runtime};
  };
  return {dataDir,open};
}

test('a hard kill after credential persistence never pairs the new key with the old provider',async t=>{
  const f=await fixture(t);
  const child=fork(new URL('../helpers/model-credential-process.mjs',import.meta.url),[f.dataDir],{
    execArgv:['--import',new URL('../helpers/network-guard.mjs',import.meta.url).href],
    env:{...process.env,RJR_DISABLE_LOCAL_CREDENTIALS:'1'},stdio:['ignore','ignore','pipe','ipc']});
  registerTestResource(t,async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}});
  const [message]=await once(child,'message');assert.equal(message.stage,'settings.credential-written');
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const credentials=createCredentialService({dataDir:f.dataDir,safeStorage:fakeSafeStorage});
  const candidate=await credentials.readForModel('deepseek');
  let writes=0;
  const {context,cfg}=await f.open(candidate,{saveModelCredential:async()=>{writes++;}});
  const initial=await context.getSettings();
  assert.equal(initial.model.configured,false);assert.equal(initial.model.credentialStatus,'needs_configuration');
  assert.equal(Boolean(cfg.deepseek.apiKey),false);assert.equal(context.modelFactory({}).available,false);
  // A setting unrelated to credentials neither clears encrypted main state nor
  // binds an empty runtime key. Rule services remain ready.
  const binding=await context.repository.getRow({collection:'settings',id:'apiKeyBinding'});
  await context.saveSettings({budgets:{maxDetails:7}});
  assert.equal(writes,0);
  assert.equal(JSON.stringify(await context.repository.getRow({collection:'settings',id:'apiKeyBinding'}))===JSON.stringify(binding),true);
  assert.equal((await context.workspaceService.listTargets()).length,0);
  await context.saveSettings({model:{apiKey:candidate,baseUrl:'https://synthetic-next.example/v1',model:'synthetic-next'}});
  assert.equal((await context.getSettings()).model.configured,true);
  const fresh=await f.open(candidate);
  assert.equal((await fresh.context.getSettings()).model.configured,true);
  assert.equal(fresh.context.modelFactory({}).baseUrl,'https://synthetic-next.example/v1');
  const archive=await context.backup();
  const publicText=JSON.stringify({settings:await context.getSettings(),backup:archive,diagnostics:await context.diagnostics.list()});
  assert.equal(publicText.includes(candidate),false);assert.equal(publicText.includes('fingerprint'),false);assert.equal(publicText.includes('apiKeyBinding'),false);
  await fresh.context.close();
  await context.restore(archive);
  assert.equal((await context.getSettings()).model.credentialStatus,'needs_configuration');
  assert.equal(context.modelFactory({}).available,false);
  assert.equal((await context.workspaceService.listTargets()).length,0);
});

test('native credential IPC commits through the real backend handler and restarts configured without duplicate credential writes',async t=>{
  const f=await fixture(t,{seed:false});let encryptedWrites=0,armed=false;
  const credentials=createCredentialService({dataDir:f.dataDir,safeStorage:{...fakeSafeStorage,
    encryptString:key=>{encryptedWrites++;return fakeSafeStorage.encryptString(key);}}});
  const {context}=await f.open('',{saveModelCredential:({apiKey})=>apiKey?credentials.save('deepseek',apiKey):credentials.delete('deepseek'),
    storageFaultInjector(stage){if(armed&&stage==='sqlite.beforeWrite'){armed=false;throw Object.assign(Error('synthetic SQL failure'),{code:'ENOSPC'});}}});
  const handlers=new Map(),frame={url:'http://127.0.0.1:3000/'},webContents={mainFrame:frame};
  let backendFailure;
  const backend=createModelCredentialHandler({requireContext:async()=>context});
  registerCredentialIpc({ipcMain:{handle:(name,action)=>handlers.set(name,action)},service:credentials,
    getWindow:()=>({webContents}),getOrigin:()=>frame.url,onKey:async key=>{try{return await backend({key});}catch(error){backendFailure=error.code;throw error;}}});
  const event={sender:webContents,senderFrame:frame};
  armed=true;
  await assert.rejects(handlers.get('credentials:save')(event,'deepseek','synthetic-IPC-failed'),{code:'credential_operation_failed'});
  assert.equal(backendFailure,'ENOSPC');
  assert.equal((await credentials.status('deepseek')).configured,false);
  assert.equal((await context.getSettings()).model.configured,false);
  const saved=await handlers.get('credentials:save')(event,'deepseek','synthetic-IPC-confirmed');
  assert.deepEqual(saved,{configured:true});
  assert.equal(encryptedWrites,2); // one failed attempt and one confirmed attempt
  assert.equal((await context.getSettings()).model.configured,true);
  const fresh=await f.open(await credentials.readForModel('deepseek'));
  assert.equal((await fresh.context.getSettings()).model.configured,true);
  assert.deepEqual(await handlers.get('credentials:delete')(event,'deepseek'),{configured:false});
  assert.equal((await credentials.status('deepseek')).configured,false);
  const removed=await f.open(await credentials.readForModel('deepseek'));
  assert.equal((await removed.context.getSettings()).model.configured,false);
  const text=JSON.stringify({settings:await context.getSettings(),backup:await context.backup(),diagnostics:await context.diagnostics.list()});
  assert.equal(text.includes('synthetic-IPC'),false);assert.equal(text.includes('fingerprint'),false);
});

test('missing bindings and direct runtime or IPC candidates fail closed until an explicit key save',async t=>{
  const f=await fixture(t,{seed:false}),{context,cfg}=await f.open();
  assert.equal((await context.getSettings()).model.credentialStatus,'needs_configuration');
  cfg.deepseek.apiKey='synthetic-direct-mutation';
  assert.equal(context.modelFactory({}).available,false);
  assert.equal((await context.setModelCredentialCandidate('synthetic-ipc-candidate')).configured,false);
  await context.saveSettings({model:{model:'synthetic-public-model'}});
  assert.equal(await context.repository.getRow({collection:'settings',id:'apiKeyBinding'}),null);
  assert.equal((await context.getSettings()).model.configured,false);
});

test('an acknowledged SQLite commit retains its matching credential after post-commit reporting fails',async t=>{
  const f=await fixture(t);let armed=false,writes=0;
  const {context}=await f.open(undefined,{saveModelCredential:async()=>{writes++;},storageFaultInjector(stage){
    if(armed&&stage==='sqlite.afterCommit'){armed=false;throw Error('synthetic reporting interruption');}
  }});
  armed=true;
  await assert.rejects(context.saveSettings({model:{apiKey:'synthetic-committed'}}),error=>error.code==='sqlite_post_commit'&&error.committed===true);
  assert.equal(writes,1);assert.equal((await context.getSettings()).model.configured,true);
  const fresh=await f.open('synthetic-committed');assert.equal((await fresh.context.getSettings()).model.configured,true);
});
