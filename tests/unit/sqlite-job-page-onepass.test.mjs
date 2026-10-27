import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteJobQueries } from '../../src/infrastructure/storage/sqlite-job-queries.mjs';
import { JOB_READ_MODEL_VERSION } from '../../src/domain/job-read-model.mjs';

// Independent pre-onepass oracle: keep its count and ordered SELECT separate.
// Do not derive it by transforming the candidate SQL or invoking candidate base.
function oldPage(db, filters, options, applicationPage=false) {
 const scope=options.scope||filters, allTargets=filters.allTargets===true;
 const page=Math.max(1,Math.floor(Number(filters.page)||1)),pageSize=Math.max(1,Math.min(200,Math.floor(Number(filters.pageSize)||50))),offset=(page-1)*pageSize;
 const asOf=new Date(options.asOf).toISOString(),bindings=[asOf,asOf,JOB_READ_MODEL_VERSION];
 const from=`FROM rows p JOIN package_keys k ON k.id=p.owner_id
  JOIN json_each(p.value,'$.temporalPeriods') period
  ON json_extract(period.value,'$.from')<=? AND (json_extract(period.value,'$.until') IS NULL OR json_extract(period.value,'$.until')>?)
  LEFT JOIN rows duplicate_group ON duplicate_group.collection='jobRelations' AND duplicate_group.owner_id=p.owner_id
  AND duplicate_group.id=json_array('confirmed-group',json_extract(p.value,'$.confirmedDuplicateGroupId'))`;
 const duplicate=`CASE WHEN json_extract(p.value,'$.duplicateStatus')='protected' OR duplicate_group.status='protected' THEN 'protected'
  WHEN json_extract(p.value,'$.duplicateStatus')='possible' OR duplicate_group.status='possible' THEN 'possible' ELSE 'normal' END`;
 const clauses=["p.collection='jobProjections'","json_extract(p.value,'$.version')=?","k.kind='target'","k.state='active'"];
 if(options.excludedOwnerPackageIds!==undefined){clauses.push('NOT EXISTS(SELECT 1 FROM json_each(?) excluded WHERE excluded.value=p.owner_id)');bindings.push(JSON.stringify(options.excludedOwnerPackageIds));}
 if(!allTargets){clauses.push('p.owner_id=?','p.target_revision_id=?');bindings.push(scope.packageId,scope.targetRevisionId);}
 const useful=value=>value!==undefined&&value!==null&&value!==''&&value!=='all';
 const add=(sql,value)=>{if(useful(value)){clauses.push(sql);bindings.push(value);}};
 add('p.kind=?',filters.kind);add('p.job_type=?',filters.jobType);add("json_extract(p.value,'$.lifecycle')=?",filters.lifecycle);
 add(`(${duplicate})=?`,filters.duplicateStatus);add("json_extract(period.value,'$.openingStatus')=?",filters.openingStatus);
 add("json_extract(p.value,'$.applicationTrackingStatus')=?",filters.applicationStatus||filters.status);
 if(useful(filters.sourceId)){clauses.push("EXISTS(SELECT 1 FROM json_each(p.value,'$.sourceIds') s WHERE s.value=?)");bindings.push(filters.sourceId);}
 if(filters.cities?.length){clauses.push("EXISTS(SELECT 1 FROM json_each(p.value,'$.cities') c JOIN json_each(?) q ON q.value=c.value)");bindings.push(JSON.stringify(filters.cities));}
 if(filters.since){clauses.push('p.sort_at>=?');bindings.push(new Date(filters.since).toISOString());}
 if(filters.search){clauses.push("instr(json_extract(p.value,'$.searchText'),?)>0");bindings.push(filters.search.toLowerCase());}
 add("json_extract(period.value,'$.qualification')=?",filters.qualification);add("json_extract(period.value,'$.recommendation')=?",filters.recommendation);
 if(applicationPage)clauses.push("json_extract(p.value,'$.applicationId') IS NOT NULL");
 const where=clauses.join(' AND '),total=db.prepare(`SELECT count(*) AS n ${from} WHERE ${where}`).get(...bindings).n;
 const items=db.prepare(`SELECT p.id AS jobId,p.owner_id AS ownerPackageId,p.target_revision_id AS targetRevisionId,
  json_extract(p.value,'$.applicationId') AS applicationId,json_extract(p.value,'$.currentObservationId') AS currentObservationId,
  json_extract(p.value,'$.evaluationId') AS evaluationId,json_extract(period.value,'$.temporalStatus') AS temporalStatus,
  json_extract(period.value,'$.until') AS nextTemporalChangeAt,${duplicate} AS duplicateStatus
  ${from} WHERE ${where}
  ORDER BY coalesce(json_extract(period.value,'$.score'),0) DESC,p.sort_at DESC,p.id ASC LIMIT ? OFFSET ?`).all(...bindings,pageSize,offset).map(row=>({...row}));
 return {items,total,page,pageSize,asOf,revision:7,jobHead:0,readOnly:allTargets};
}

function fixture() {
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE rows(collection TEXT,id TEXT NOT NULL,owner_id TEXT,target_revision_id TEXT,kind TEXT,job_type TEXT,sort_at TEXT,status TEXT,value TEXT,PRIMARY KEY(collection,id));
  CREATE TABLE package_keys(id TEXT PRIMARY KEY,kind TEXT,state TEXT);
  CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT);
  CREATE TABLE changes(seq INTEGER,collection TEXT,owner_id TEXT,id TEXT);
  CREATE INDEX rows_owner ON rows(collection,owner_id,id);
  INSERT INTO package_keys VALUES('A','target','active'),('B','target','active'),('hidden','target','trashed'),('profile','profile','active');
  INSERT INTO store_meta VALUES('revision','7');`);
 const from='2026-10-10T00:00:00.000Z',exact='2026-10-13T00:00:00.000Z',boundary='2026-10-13T00:00:00.001Z';
 const period=overrides=>({from,until:null,score:60,qualification:'pass',recommendation:'high',openingStatus:'open',applicationStatus:'available',temporalStatus:'current',...overrides});
 const put=db.prepare('INSERT INTO rows VALUES(?,?,?,?,?,?,?,?,?)');
 const projection=(id,value={},routing={})=>{
  const owner=routing.owner||'A',target=routing.target||'TA';
  put.run('jobProjections',id,owner,target,routing.kind||'job',routing.jobType||'social',routing.sortAt===undefined?from:routing.sortAt,null,JSON.stringify({version:JOB_READ_MODEL_VERSION,applicationId:null,currentObservationId:'obs-'+id,evaluationId:'eval-'+id,lifecycle:'observed',duplicateStatus:'normal',applicationTrackingStatus:'new',sourceIds:['synthetic'],cities:['X'],searchText:'fire safety '+id,temporalPeriods:[period({})],...value}));
 };
 projection('score-text',{temporalPeriods:[period({score:'9'})]});
 projection('score-number',{temporalPeriods:[period({score:90})]});
 projection('tie-a',{applicationId:'app-a',confirmedDuplicateGroupId:'protected-group'});
 projection('tie-b',{applicationId:'app-b',duplicateStatus:'possible',sourceIds:['alternate'],cities:['Y'],applicationTrackingStatus:'applied'});
 projection('score-null',{temporalPeriods:[period({score:null})]});
 projection('score-zero',{temporalPeriods:[period({score:0})]});
 projection('closed',{lifecycle:'seen',applicationId:'',temporalPeriods:[period({score:20,qualification:'fail',recommendation:'not_recommended',openingStatus:'closed'})]},{kind:'notice',jobType:'intern',sortAt:'2026-10-11T00:00:00.000Z'});
 projection('expires',{applicationId:'app-e',temporalPeriods:[period({until:boundary}),period({from:boundary,score:0,qualification:'unknown',recommendation:'insufficient',temporalStatus:'needs_recalculation'})]});
 projection('without-time',{temporalPeriods:[]});
 projection('future',{temporalPeriods:[period({from:'2027-01-01T00:00:00.000Z'})]});
 projection('old-version',{version:JOB_READ_MODEL_VERSION-1});
 projection('other-target',{}, {target:'TA2'});
 projection('B-only',{applicationId:'app-B'},{owner:'B',target:'TB'});
 projection('hidden-only',{}, {owner:'hidden',target:'TH'});
 projection('profile-only',{}, {owner:'profile',target:'TP'});
 put.run('jobRelations',JSON.stringify(['confirmed-group','protected-group']),'A',null,null,null,null,'protected','{}');
 return {db,from,exact,boundary,period,projection};
}

test('onepass page matches the independent old count/page oracle across filters, scopes, empty pages and temporal boundaries', () => {
 const f=fixture();try{
  let returnedRows=0;const queries=createSqliteJobQueries({db:f.db,countRows:n=>returnedRows+=n}),scope={packageId:'A',targetRevisionId:'TA'};
  const variants=[{}, {page:1,pageSize:1},{page:2,pageSize:1},{page:2,pageSize:25},{page:2,pageSize:50},{page:100001,pageSize:1},{pageSize:200},{pageSize:201},
   {kind:'notice'},{jobType:'intern'},{lifecycle:'seen'},{duplicateStatus:'protected'},{duplicateStatus:'possible'},{openingStatus:'closed'},
   {applicationStatus:'applied'},{status:'applied'},{sourceId:'alternate'},{cities:['Y']},{since:'2026-10-11T00:00:00Z'},
   {search:'TIE-A'},{search:'none'},{qualification:'fail'},{qualification:'unknown'},{recommendation:'insufficient'},
   {sourceId:'all',qualification:'all',duplicateStatus:'all'},{cities:['X'],sourceId:'synthetic',qualification:'pass',openingStatus:'open'}];
  for(const asOf of [f.from,f.exact,f.boundary])for(const applicationPage of [false,true])for(const variant of variants){
   const filters={...scope,...variant},options={scope,asOf};returnedRows=0;
   const result=queries[applicationPage?'queryApplicationPage':'queryJobPage'](filters,options);
   assert.deepEqual(result,oldPage(f.db,filters,options,applicationPage));
   assert.equal(returnedRows,Math.max(1,result.items.length)+2,'count actual SELECT/sentinel, revision and head rows');
   assert.ok(result.items.length<=result.pageSize);assert.ok(result.items.every(row=>row.jobId!==null&&!Object.hasOwn(row,'total')));
  }
  for(const excludedOwnerPackageIds of [[],['A'],['A','B'],['hidden']])for(const applicationPage of [false,true]){
   const filters={allTargets:true,pageSize:2,page:2},options={asOf:f.exact,excludedOwnerPackageIds};
   assert.deepEqual(queries[applicationPage?'queryApplicationPage':'queryJobPage'](filters,options),oldPage(f.db,filters,options,applicationPage));
  }
  const sorted=queries.queryJobPage(scope,{scope,asOf:f.exact});
  assert.deepEqual(sorted.items.slice(0,2).map(row=>row.jobId),['score-text','score-number'],'retain SQLite text-vs-number ordering without a cast');
  const tied=sorted.items.filter(row=>row.jobId.startsWith('tie-')).map(row=>row.jobId);assert.deepEqual(tied,['tie-a','tie-b']);
  assert.equal(sorted.items.find(row=>row.jobId==='tie-a').duplicateStatus,'protected');
  assert.equal(queries.queryJobPage({...scope,page:2,pageSize:1,search:'score-text'},{scope,asOf:f.exact}).total,1,'out-of-range page retains exact nonzero total');
  assert.equal(queries.queryJobPage({...scope,search:'none'},{scope,asOf:f.exact}).total,0);
  assert.throws(()=>queries.queryJobPage({...scope,page:100002,pageSize:1},{scope,asOf:f.exact}),{code:'sqlite_selection_invalid'});
  assert.throws(()=>queries.queryJobPage({allTargets:true,...scope},{asOf:f.exact}),{code:'sqlite_selection_invalid'});
  assert.throws(()=>queries.queryJobPage(scope,{scope,asOf:f.exact,excludedOwnerPackageIds:['A',1]}),{code:'sqlite_selection_invalid'});
 }finally{f.db.close();}
});

test('onepass does not deduplicate multiple active periods and performs bounded projection seeks after materializing one eligibility set', () => {
 const f=fixture();try{
  f.projection('multiple',{searchText:'multiple-periods',temporalPeriods:[f.period({score:45,until:'2027-01-01T00:00:00.000Z'}),f.period({score:44,temporalStatus:'needs_recalculation'})]});
  let plan;const queries=createSqliteJobQueries({db:f.db,statement:sql=>{const prepared=f.db.prepare(sql);return Object.fromEntries(['get','all'].map(method=>[method,(...bindings)=>{if(sql.startsWith('WITH eligible'))plan=f.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...bindings);return prepared[method](...bindings);}]))}});
  const scope={packageId:'A',targetRevisionId:'TA'},options={scope,asOf:f.exact};
  for(const page of [1,2,3]){
   const filters={...scope,page,pageSize:1,search:'multiple-periods'},result=queries.queryJobPage(filters,options);
   assert.deepEqual(result,oldPage(f.db,filters,options));assert.equal(result.total,2);assert.equal(result.items.length,page===3?0:1);
  }
  assert.equal(plan.filter(row=>row.detail==='MATERIALIZE eligible').length,1);
  assert.ok(plan.some(row=>row.detail==='MATERIALIZE page'));
  assert.ok(plan.some(row=>/SEARCH p USING INDEX .* \(collection=\?(?: AND owner_id=\?)? AND id=\?(?: AND owner_id=\?)?\) LEFT-JOIN$/.test(row.detail)),JSON.stringify(plan.map(row=>row.detail)));
 }finally{f.db.close();}
});
