import { createApplicationContext } from '../../src/application/context.mjs';
import { DEFAULT_CONFIG } from '../../src/config.mjs';
import { createSourceRegistry } from '../../src/sources/registry.mjs';
import { createCredentialService,registerCredentialIpc } from '../../electron/credentials.mjs';
import { createModelCredentialHandler } from '../../electron/backend/service.mjs';

const dataDir=process.argv[2],cfg=structuredClone(DEFAULT_CONFIG);
cfg.deepseek.apiKey='synthetic-before-crash';
const service=createCredentialService({dataDir,safeStorage:{isEncryptionAvailable:()=>true,
  encryptString:key=>Buffer.from('synthetic-encrypted:'+key).reverse(),
  decryptString:value=>Buffer.from(value).reverse().toString().slice('synthetic-encrypted:'.length)}});
const context=await createApplicationContext({cfg,dataDir,dependencies:{startScheduler:false,
  registry:createSourceRegistry([]),catalog:[],
  saveModelCredential:({apiKey})=>apiKey?service.save('deepseek',apiKey):service.delete('deepseek'),
  async settingsFaultInjector(stage){
    if(stage==='settings.credential-written'){
      process.send({stage});
      await new Promise(()=>{});
    }
  },
}});
const handlers=new Map(),frame={url:'http://127.0.0.1:3000/'},webContents={mainFrame:frame};
const backend=createModelCredentialHandler({requireContext:async()=>context});
registerCredentialIpc({ipcMain:{handle:(name,action)=>handlers.set(name,action)},service,
  getWindow:()=>({webContents}),getOrigin:()=>frame.url,onKey:key=>backend({key})});
await handlers.get('credentials:save')({sender:webContents,senderFrame:frame},'deepseek','synthetic-after-crash');
