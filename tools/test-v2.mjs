import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const walk=dir=>fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{
  const p=path.join(dir,e.name);return e.isDirectory()?walk(p):p.endsWith('.test.mjs')?[p]:[];
}):[];
let files=walk(path.join(root,'tests')).sort();
const relative=p=>path.relative(root,p).split(path.sep).join('/');
const index=args.indexOf('--file'),groupIndex=args.indexOf('--group');
if(index>=0){
  const candidate=path.resolve(root,args[index+1]||'');
  if(!files.includes(candidate)){console.error('Unknown test file');process.exit(1);}
  files=[candidate];
}
if(groupIndex>=0){
  const group=args[groupIndex+1];
  if(!['unit','integration','e2e'].includes(group)){console.error('Unknown test group');process.exit(1);}
  files=files.filter(p=>relative(p).startsWith('tests/'+group+'/'));
}
if(args.includes('--list')){console.log(JSON.stringify(files.map(relative)));process.exit(0);}
if(!files.length){console.error('No tests discovered');process.exit(1);}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rjr-v2-'));
try{
  const result=spawnSync(process.execPath,['--import',pathToFileURL(path.join(root,'tests/helpers/network-guard.mjs')).href,'--test',...files],
    {cwd:root,stdio:'inherit',env:{...process.env,RJR_DATA_DIR:dir},timeout:300000});
  process.exitCode=result.status??1;if(result.error)console.error(result.error.message);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
