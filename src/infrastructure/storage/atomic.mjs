import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export async function writeAtomicJson(filename,value,{fsAdapter=fs}={}) {
 await fsAdapter.mkdir(path.dirname(filename),{recursive:true});
 const temp=filename+'.'+randomUUID()+'.tmp';let handle;
 try {handle=await fsAdapter.open(temp,'wx');await handle.writeFile(JSON.stringify(value,null,2),'utf8');await handle.sync();await handle.close();handle=null;await fsAdapter.rename(temp,filename);}
 finally {if(handle)await handle.close().catch(()=>{});await fsAdapter.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
