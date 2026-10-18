import { openWorkspaceRepository } from '../../src/infrastructure/storage/repository.mjs';
const [dataDir,packageId,targetRevisionId]=process.argv.slice(2),scope={packageId,targetRevisionId};
const repository=await openWorkspaceRepository({dataDir});
await repository.queryRows({collection:'jobs',ownerPackageId:packageId,ids:[]},{scope});
process.send({ready:true});
process.once('message',async()=>{
  let code='unexpected-success';
  try{await repository.queryRows({collection:'jobs',ownerPackageId:packageId,ids:[]},{scope});}catch(error){code=error.code;}
  process.send({code});await repository.close();process.disconnect();
});
