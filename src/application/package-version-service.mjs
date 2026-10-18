import { randomUUID } from 'node:crypto';
import { assertInput, inputError } from '../../public/js/validation-rules.js';
import { contentHash, canonicalContentHash } from '../infrastructure/storage/content-hash.mjs';
import { rowKey } from '../infrastructure/storage/sqlite-records.mjs';
import { assertVersionNameAvailable } from '../domain/version-names.mjs';
import { requirePackage, packageError } from '../domain/packages.mjs';
import { versionAvailability } from '../domain/version-references.mjs';

const requestHash=input=>canonicalContentHash(Object.fromEntries(Object.entries(input).filter(([key])=>key!=='submissionId')));
const keyOf=kind=>kind==='profile'?'profiles':'targets';
const submissionKey=(kind,input)=>input.submissionId?kind+':'+input.submissionId:null;
const assertSubmission=input=>{
  if(input.submissionId!==undefined&&(typeof input.submissionId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(input.submissionId)))
    throw inputError({submissionId:'提交标识无效，请重新提交。'});
};

/** Schema3 version commands use bounded rows. Whole-workspace compatibility lives in WorkspaceService only. */
export function createPackageVersionService({repository,clock=repository.clock,sourceIds,siteIds,modelConfig,trashService}){
  const at=()=>new Date(clock.now()).toISOString();
  async function descriptor(port,args){
    let pkg;
    if(args.packageId)pkg=await port.getRow({collection:'packages',id:args.packageId});
    else if(args.revisionId){
      const meta=await port.getRecord({collection:'versionMetadata',id:args.revisionId});
      if(meta?.indexes.ownerPackageId)pkg=await port.getRow({collection:'packages',id:meta.indexes.ownerPackageId});
    }
    if(!pkg)throw packageError('package_not_found','版本不存在，请刷新列表。',404);
    if((args.revisionId&&args.revisionId!==pkg.versionId)||(args.kind&&args.kind!==pkg.kind)||
      (args.parentId&&pkg.versionId.slice(0,pkg.versionId.lastIndexOf('@'))!==args.parentId))
      throw packageError('package_scope_mismatch','所选版本与数据包不一致。');
    return pkg;
  }
  async function readVersion(port,pkg){
    const r=await port.getRow({collection:keyOf(pkg.kind),id:pkg.versionId,ownerPackageId:pkg.packageId});
    if(!r)return null;
    if(pkg.kind==='target'){
      const copies=await port.queryRows({collection:'profileCopies',ownerPackageId:pkg.packageId,where:{parentId:r.revisionId},limit:2});
      if(copies.hasMore||copies.rows.length>1)throw packageError('package_scope_mismatch','目标简历副本身份不唯一。');
      if(copies.rows.length)r.profileSnapshot=copies.rows[0].value;
    }
    return r;
  }
  async function view(port,pkg,r){
    if(!r)return null;
    const meta=await port.getRow({collection:'versionMetadata',id:r.revisionId});
    const counts=await port.getPackageCounts(pkg.packageId);
    return {...r,...meta,packageId:pkg.packageId,state:pkg.state,counts,
      availability:pkg.kind==='target'?versionAvailability({schemaVersion:3,packages:{[pkg.packageId]:pkg}},r):{canCollect:true,canRescore:true,reasonCode:null}};
  }
  const assertName=(fence,kind,name,revisionId=null)=>{
    const packages=fence.queryRows({collection:'packages',where:{kind,nameKey:String(name||'').normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase()},limit:2});
    const metadata=fence.queryRows({collection:'versionMetadata',where:{kind,nameKey:String(name||'').normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase()},limit:2});
    return assertVersionNameAvailable({packages:Object.fromEntries(packages.rows.map(row=>[row.id,row.value])),
      versionMetadata:Object.fromEntries(metadata.rows.map(row=>[row.id,row.value]))},
      {kind,versionName:name,revisionId,control:fence.control});
  };
  async function reserve(fence,input,kind,submissionInput){
    const control=fence.control,hash=requestHash(submissionInput),token=contentHash([kind,input.submissionId||randomUUID()]);
    const reservations=(control.migrationJournal.versionReservations||={});
    if(reservations[token]){
      const prior=reservations[token];
      if(prior.inputHash!==hash)throw packageError('version_submission_conflict','同一提交标识的内容已变化，请重新提交。');
      if(control.deletionLedger[prior.packageId])throw packageError('version_submission_retired','原版本已永久清理，请发起新的提交。');
      return structuredClone(prior);
    }
    const parentId=input[kind+'Id']||(kind==='profile'?'p-':'t-')+randomUUID();
    const counterKey=kind+':'+parentId,counter=fence.getRow({collection:'versionCounters',id:rowKey(kind,parentId)})||0;
    const number=Math.max(control.versionHighWater[counterKey]||0,counter)+1;
    if(!Number.isSafeInteger(number))throw packageError('version_sequence_exhausted','版本编号已耗尽，不能重新使用旧编号。',503);
    const reservation={inputHash:hash,parentId,number,revisionId:parentId+'@'+number,packageId:randomUUID(),recordId:randomUUID(),
      profileSnapshotId:kind==='target'?randomUUID():null,createdAt:at()};
    reservations[token]=reservation;control.versionHighWater[counterKey]=number;
    control.identityIndex.package['version:'+token]=reservation.packageId;control.identityIndex.record['version:'+token]=reservation.recordId;
    if(reservation.profileSnapshotId)control.identityIndex.record['profile-copy:'+token]=reservation.profileSnapshotId;
    await fence.commitControl(control);return reservation;
  }
  async function save(input,kind,{submissionInput=input}={}){
    assertSubmission(input);
    return repository.withWriteFence(async fence=>{
      const subId=submissionKey(kind,input),prior=subId&&fence.getRow({collection:'versionSubmissions',id:subId});
      if(prior){
        if(prior.inputHash!==requestHash(submissionInput))throw packageError('version_submission_conflict','同一提交标识的内容已变化，请重新提交。');
        const pkg=await descriptor(fence,{revisionId:prior.revisionId,kind});
        requirePackage({packages:{[pkg.packageId]:pkg}},pkg.packageId,{now:clock.now()});
        const row=await readVersion(fence,pkg);
        if(!row)throw packageError('version_submission_retired','原版本已永久清理，请发起新的提交。');
        return view(fence,pkg,row);
      }
      const normalized=assertName(fence,kind,input.versionName||(kind==='profile'?'简历 '+at().slice(0,10)+' '+randomUUID().slice(0,8):null));
      let source;
      if(kind==='profile')assertInput('profile',input,{partial:true});
      else{
        const validationWorkspace={settings:{customSites:fence.getRow({collection:'settings',id:'customSites'})||[]}};
        assertInput('target',input,{nativeTypes:true,model:typeof modelConfig==='function'?modelConfig():modelConfig,
          sourceIds:typeof sourceIds==='function'?sourceIds():sourceIds,siteIds:typeof siteIds==='function'?siteIds(validationWorkspace):siteIds});
        let pkg;
        try{pkg=await descriptor(fence,{revisionId:input.profileRevisionId,kind:'profile'});}catch(error){if(error.code!=='package_not_found')throw error;}
        if(!pkg)throw inputError({profileRevisionId:'画像版本已不存在，请重新选择。'});
        requirePackage({packages:{[pkg.packageId]:pkg}},pkg.packageId,{now:clock.now()});source=await readVersion(fence,pkg);
      }
      const reserved=await reserve(fence,input,kind,submissionInput);
      const {parentId,number,revisionId,packageId,recordId,createdAt}=reserved;
      const r={recordId,ownerPackageId:packageId,packageId,[kind+'Id']:parentId,revision:number,revisionId,createdAt};
      let copy;
      if(kind==='profile'){
        const text=String(input.text||''),overrides=structuredClone(input.overrides||{}),profile={...structuredClone(input.profile||{}),...overrides};
        Object.assign(r,{text,profile,overrides,contentHash:contentHash({text,profile,overrides}),parserVersion:input.parserVersion||'confirmed-1',importMetadata:structuredClone(input.importMetadata||input.import||null)});
      }else{
        copy={...structuredClone(source),profileId:'copy-'+packageId,revisionId:'copy-'+packageId+'@1',revision:1,recordId:reserved.profileSnapshotId,
          ownerPackageId:packageId,packageId,provenance:{profileRevisionId:source.revisionId,sourcePackageId:source.ownerPackageId}};
        Object.assign(r,{profileRevisionId:source.revisionId,incomplete:false,enabled:input.enabled!==false,roles:[...new Set(input.roles||input.targetRoles)],
          cityMode:input.cityMode||(input.cities==null?'from_profile':input.cities.length?'selected':'any'),cities:[...new Set(input.cities||[])],
          graduationYear:input.graduationYear||copy.profile.graduationYear||null,jobTypes:[...new Set(input.jobTypes||['campus','internship'])],
          degreePolicy:input.degreePolicy||(input.minDegree?'minimum_requirement':'eligibility'),minDegree:input.minDegree||null,
          sourceIds:[...new Set(input.sourceIds||[])],siteIds:[...new Set(input.siteIds||[])],coverageMode:input.coverageMode||'standard',budgets:structuredClone(input.budgets||{})});
      }
      const group=kind==='profile'?'profileGroups':'targetGroups',collection=keyOf(kind);
      const selectors=[{collection:'packages',ids:[packageId]},{collection,ownerPackageId:packageId,ids:[revisionId]},
        {collection:group,ids:[parentId]},{collection:'versionMetadata',ids:[revisionId]},
        {collection:'versionCounters',ids:[rowKey(kind,parentId)]}];
      if(subId)selectors.push({collection:'versionSubmissions',ids:[subId]});
      if(copy)selectors.push({collection:'profileCopies',ownerPackageId:packageId,ids:[copy.revisionId]},
        {collection:'memberGroups',ownerPackageId:packageId,ids:[revisionId]});
      const pkg={packageId,kind,versionId:revisionId,...normalized,enabled:kind==='profile'||r.enabled!==false,state:'active',archiveId:null,archivedAt:null,purgeAt:null};
      fence.transaction({select:selectors},tx=>{
        tx.putRow({collection:'packages',id:packageId,value:pkg});tx.putRow({collection:group,id:parentId,value:{}});
        tx.putRow({collection,id:revisionId,ownerPackageId:packageId,value:r});
        tx.putRow({collection:'versionMetadata',id:revisionId,ownerPackageId:packageId,value:{kind,...normalized,enabled:pkg.enabled,archivedAt:null,updatedAt:createdAt}});
        tx.putRow({collection:'versionCounters',id:rowKey(kind,parentId),value:number});
        if(subId)tx.putRow({collection:'versionSubmissions',id:subId,value:{revisionId,inputHash:requestHash(submissionInput)}});
        if(copy){tx.putRow({collection:'profileCopies',id:copy.revisionId,ownerPackageId:packageId,value:copy,parent:{collection:'targets',id:revisionId,path:'profileSnapshot'},ordinal:0});
          tx.putRow({collection:'memberGroups',id:revisionId,ownerPackageId:packageId,targetRevisionId:revisionId,value:{}});}
      });
      return view(fence,pkg,copy?{...r,profileSnapshot:copy}:r);
    });
  }
  async function get(kind,id){
    let pkg;try{pkg=await descriptor(repository,{kind,revisionId:id});}catch(error){if(error.code==='package_not_found')return null;throw error;}
    return view(repository,pkg,await readVersion(repository,pkg));
  }
  async function list(kind){
    const result=[];let afterId;
    do{
      const page=await repository.queryRows({collection:'packages',where:{kind,status:'active'},limit:200,...(afterId?{afterId}:{})});
      // Package state is indexed through status; older imports also receive it in recordMetadata.
      for(const row of page.rows)result.push(await get(kind,row.value.versionId));
      afterId=page.hasMore?page.nextCursor:null;
    }while(afterId);
    return result.filter(Boolean);
  }
  const lifecycle=action=>async args=>{
    if(!trashService)throw packageError('package_lifecycle_required','请通过回收站服务操作版本。');
    // Metadata lookup only; an expired purge action does not read a resume body.
    const pkg=args.packageId?(await repository.queryRows({collection:'packages',ids:[args.packageId],limit:1})).rows[0]?.value:null;
    const revisionId=args.revisionId||pkg?.versionId;
    const meta=revisionId?await repository.getRecord({collection:'versionMetadata',id:revisionId}):null;
    const packageId=args.packageId||meta?.indexes.ownerPackageId;
    if(!packageId)throw packageError('package_not_found','版本不存在，请刷新列表。',404);
    if((meta?.indexes.ownerPackageId&&meta.indexes.ownerPackageId!==packageId)||
       (pkg&&args.revisionId&&pkg.versionId!==args.revisionId)||
       (args.kind&&(pkg?.kind||meta?.value.kind)&&(pkg?.kind||meta?.value.kind)!==args.kind)||
       (args.parentId&&revisionId?.slice(0,revisionId.lastIndexOf('@'))!==args.parentId))
      throw packageError('package_scope_mismatch','所选版本与数据包不一致。');
    return trashService[action]({...args,packageId});
  };
  return {saveProfile:input=>save(input,'profile'),saveTarget:(input,options)=>save(input,'target',options),
    getProfileRevision:id=>get('profile',id),getTargetRevision:id=>get('target',id),listProfiles:()=>list('profile'),listTargets:()=>list('target'),
    async updateVersion(args){
      return repository.withWriteFence(async fence=>{
        const pkg=await descriptor(fence,args),r=await readVersion(fence,pkg),meta=fence.getRow({collection:'versionMetadata',id:pkg.versionId});
        requirePackage({packages:{[pkg.packageId]:pkg}},pkg.packageId,{now:clock.now()});
        if(args.versionName!==undefined){const name=assertName(fence,pkg.kind,args.versionName,pkg.versionId);Object.assign(pkg,name);Object.assign(meta,name);}
        if(args.enabled!==undefined){if(pkg.kind!=='target'||typeof args.enabled!=='boolean')throw inputError({enabled:'目标启停状态需要布尔值。'});pkg.enabled=args.enabled;meta.enabled=args.enabled;}
        meta.updatedAt=at();
        fence.transaction({select:[{collection:'packages',ids:[pkg.packageId]},{collection:'versionMetadata',ids:[pkg.versionId]}]},tx=>{
          tx.putRow({collection:'packages',id:pkg.packageId,value:pkg});tx.putRow({collection:'versionMetadata',id:pkg.versionId,ownerPackageId:pkg.packageId,value:meta});
        });return view(fence,pkg,r);
      },{operationLease:args.operationLease});
    },
    archiveVersion:lifecycle('archive'),restoreVersion:lifecycle('restore'),permanentlyDeleteVersion:lifecycle('purgeOne'),
    deleteProfileRevision:id=>lifecycle('archive')({revisionId:id,kind:'profile'}),};
}
