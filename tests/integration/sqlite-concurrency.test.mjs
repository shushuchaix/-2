import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { openSqliteRowStore } from '../../src/infrastructure/storage/sqlite-store.mjs';
import {createEmptyWorkspace} from '../../src/domain/contracts.mjs';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
async function fixture(t){
  const directory=path.resolve('.cache','sqlite-concurrency-tests',randomUUID());await fs.mkdir(directory,{recursive:true});
  const filename=path.join(directory,'workspace.sqlite'),stores=[];
  const open=options=>{const store=openSqliteRowStore({filename,busyTimeoutMs:40,...options});stores.push(store);return store;};
  const script=path.join(directory,'child.mjs');
  const moduleURL=pathToFileURL(path.resolve('src/infrastructure/storage/sqlite-store.mjs')).href;
  await fs.writeFile(script,`import fs from 'node:fs';
import {openSqliteRowStore} from ${JSON.stringify(moduleURL)};
const [filename,mode,signal,count]=process.argv.slice(2);
const pause=phase=>{if(phase===mode){fs.writeFileSync(signal,phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}};
const store=openSqliteRowStore({filename,busyTimeoutMs:5000,faultInjector:pause});
process.send({ready:true});
process.on('message',message=>{if(message!=='go')return;
try{for(let i=0;i<Number(count||1);i++)store.transaction({select:[],metaKeys:['counter']},tx=>tx.setMeta('counter',(tx.getMeta('counter')||0)+1));store.close();process.send({done:true});process.disconnect();}
catch(error){process.send({error:error.code||error.message});process.exitCode=1;process.disconnect();}});
`);
  t.after(()=>{for(const store of stores)store.close();});return{directory,filename,script,open};
}
function child(f,mode='normal',count=1){
  const signal=path.join(f.directory,randomUUID()+'.signal');
  const proc=fork(f.script,[f.filename,mode,signal,String(count)],{execPath:process.execPath,execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';proc.stderr.on('data',data=>{stderr=(stderr+data).slice(-4096);});
  const ready=new Promise((resolve,reject)=>{proc.on('message',m=>{if(m.ready)resolve();if(m.error)reject(Error(m.error));});proc.once('error',reject);proc.once('exit',code=>{if(code)reject(Error('child exit '+code+': '+stderr));});});
  const exited=new Promise(resolve=>proc.once('exit',(code,signal)=>resolve({code,signal})));
  return{proc,ready,exited,signal};
}
async function waitSignal(filename){const until=Date.now()+10000;while(Date.now()<until){try{await fs.stat(filename);return;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,20));}throw Error('child did not reach real commit boundary');}

test('SQLite two processes serialize read-modify-write without losing confirmed commits',async t=>{
  const f=await fixture(t),store=f.open(),a=child(f,'normal',15),b=child(f,'normal',15);
  t.after(()=>{a.proc.kill();b.proc.kill();});
  await Promise.all([a.ready,b.ready]);a.proc.send('go');b.proc.send('go');
  const exits=await Promise.all([a.exited,b.exited]);assert.deepEqual(exits.map(e=>e.code),[0,0]);
  assert.equal(store.getMeta('counter'),30);assert.equal(store.getMeta('revision'),30);
  assert.equal(store.readChanges().changes.length,30);
});

test('SQLite killing a writer before versus after COMMIT preserves the correct durable result',async t=>{
  const f=await fixture(t),store=f.open();
  for(const [mode,expected] of [['beforeCommit',undefined],['afterCommit',1]]){
    const writer=child(f,mode);t.after(()=>writer.proc.kill());await writer.ready;writer.proc.send('go');
    await waitSignal(writer.signal);writer.proc.kill('SIGKILL');await writer.exited;
    const reopened=f.open();assert.equal(reopened.getMeta('counter'),expected);
    assert.deepEqual(reopened.integrityCheck(),{integrity:['ok'],foreignKeys:[]});
  }
  assert.equal(store.getMeta('counter'),1);
});

test('SQLite real lock busy rolls back; a long reader blocks physical checkpoint until released',async t=>{
  const f=await fixture(t),store=f.open(),other=new DatabaseSync(f.filename,{timeout:40});t.after(()=>other.close());
  other.exec('BEGIN IMMEDIATE');
  assert.throws(()=>store.transaction({select:[],metaKeys:['counter']},tx=>tx.setMeta('counter',1)),{code:'sqlite_busy'});
  assert.equal(store.getMeta('counter'),undefined);other.exec('ROLLBACK');
  store.transaction({select:[],metaKeys:['counter']},tx=>tx.setMeta('counter',1));
  other.exec('BEGIN');other.prepare('SELECT value FROM store_meta WHERE key=?').get('counter');
  store.transaction({select:[],metaKeys:['counter']},tx=>tx.setMeta('counter',2));
  assert.equal(store.checkpoint().complete,false);assert.equal(store.compact().complete,false);
  other.exec('ROLLBACK');assert.equal(store.checkpoint().complete,true);assert.equal(store.compact().complete,true);
});

test('SQLite future store format and corrupt bytes are not silently replaced',async t=>{
  const f=await fixture(t),store=f.open();store.close();
  const raw=new DatabaseSync(f.filename);raw.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  raw.prepare('UPDATE store_meta SET value=? WHERE key=?').run('99','storeVersion');raw.close();
  const before=await fs.readFile(f.filename);
  assert.throws(()=>openSqliteRowStore({filename:f.filename}),{code:'sqlite_store_version'});
  assert.deepEqual(await fs.readFile(f.filename),before);
  const corrupt=path.join(f.directory,'corrupt.sqlite');await fs.writeFile(corrupt,'synthetic invalid database');
  assert.throws(()=>openSqliteRowStore({filename:corrupt}),/database|file/i);
  assert.equal(await fs.readFile(corrupt,'utf8'),'synthetic invalid database');
  const foreign=path.join(f.directory,'foreign.sqlite'),foreignDb=new DatabaseSync(foreign);
  foreignDb.exec('CREATE TABLE another_application(id INTEGER PRIMARY KEY,body TEXT);');
  foreignDb.prepare('INSERT INTO another_application(body) VALUES (?)').run('synthetic external database');foreignDb.close();
  const foreignBefore=await fs.readFile(foreign);
  assert.throws(()=>openSqliteRowStore({filename:foreign}),{code:'sqlite_store_unrecognized'});
  assert.deepEqual(await fs.readFile(foreign),foreignBefore);
});

test('SQLite a delayed first opener cannot reset another process confirmed import or hide extensions',async t=>{
  const f=await fixture(t),reached=path.join(f.directory,'empty-observed.signal'),go=path.join(f.directory,'continue.signal');
  const racerScript=path.join(f.directory,'first-opener.mjs');
  const moduleURL=pathToFileURL(path.resolve('src/infrastructure/storage/sqlite-store.mjs')).href;
  await fs.writeFile(racerScript,`import fs from 'node:fs';import {createRequire} from 'node:module';
const sqlite=createRequire(import.meta.url)('node:sqlite'),Native=sqlite.DatabaseSync;
const [filename,reached,go]=process.argv.slice(2);let paused=false;
sqlite.DatabaseSync=class extends Native{prepare(sql){const statement=super.prepare(sql);
if(sql === "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1"){
const get=statement.get.bind(statement);statement.get=(...args)=>{const result=get(...args);if(!result&&!paused){paused=true;fs.writeFileSync(reached,'observed empty');
const wait=new Int32Array(new SharedArrayBuffer(4));while(!fs.existsSync(go))Atomics.wait(wait,0,0,10);}return result;};}return statement;}};
const {openSqliteRowStore}=await import(${JSON.stringify(moduleURL)});const store=openSqliteRowStore({filename,busyTimeoutMs:5000});
process.stdout.write(JSON.stringify({revision:store.getMeta('revision'),extension:store.exportWorkspace().syntheticHistoricalExtension}));store.close();
`);
  const delayed=fork(racerScript,[f.filename,reached,go],{execPath:process.execPath,execArgv:[],stdio:['ignore','pipe','pipe','ipc']});
  t.after(()=>delayed.kill());let output='',stderr='';delayed.stdout.on('data',b=>output+=b);delayed.stderr.on('data',b=>stderr+=b);
  const exited=new Promise((resolve,reject)=>{delayed.once('error',reject);delayed.once('exit',code=>resolve(code));});
  await waitSignal(reached);
  const store=f.open(),workspace=createEmptyWorkspace({schemaVersion:3});workspace.revision=17;workspace.syntheticHistoricalExtension={kept:true};
  store.importWorkspace(workspace);const before=store.exportWorkspace();
  await fs.writeFile(go,'continue');assert.equal(await exited,0,stderr);
  assert.equal(store.getMeta('revision'),17);assert.deepEqual(store.exportWorkspace(),before);
  assert.deepEqual(JSON.parse(output),{revision:17,extension:{kept:true}});
});
