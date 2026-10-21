import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteJobQueries } from '../../src/infrastructure/storage/sqlite-job-queries.mjs';
import { recordMetadata } from '../../src/infrastructure/storage/sqlite-records.mjs';

// Preserve the pre-routing query as an independent aggregate oracle. The
// fixtures exercise temporal selection and relation membership, not latency.
const originalSql = `WITH selected AS MATERIALIZED (
 SELECT p.id AS job_id,p.owner_id,json_extract(p.value,'$.bodyVerified') AS body_verified,
 json_extract(period.value,'$.qualification') AS qualification,json_extract(period.value,'$.recommended') AS recommended,
 json_extract(period.value,'$.openingStatus') AS opening_status,json_extract(period.value,'$.applicationStatus') AS application_status,
 json_extract(period.value,'$.temporalStatus') AS temporal_status,json_extract(period.value,'$.until') AS next_temporal_change_at
 FROM rows p JOIN package_keys k ON k.id=p.owner_id
 JOIN json_each(p.value,'$.temporalPeriods') period
 ON json_extract(period.value,'$.from')<=? AND (json_extract(period.value,'$.until') IS NULL OR json_extract(period.value,'$.until')>?)
 LEFT JOIN rows duplicate_group ON duplicate_group.collection='jobRelations' AND duplicate_group.owner_id=p.owner_id
 AND duplicate_group.id=json_array('confirmed-group',json_extract(p.value,'$.confirmedDuplicateGroupId'))
 WHERE p.collection='jobProjections' AND p.owner_id=? AND k.state='active' AND p.fact_hash IS NOT NULL
 AND (? IS NULL OR p.job_id IN (SELECT o.job_id FROM rows o WHERE o.collection='observations' AND o.owner_id=? AND o.run_id=?))
 AND (? IS NULL OR p.job_id IN (SELECT json_extract(a.value,'$') FROM rows a WHERE a.collection='activityJobIds' AND a.owner_id=? AND a.run_id=?)))
 SELECT count(*) AS uniqueRecords,
 coalesce(sum(body_verified=1),0) AS bodyVerified,coalesce(sum(opening_status='open'),0) AS open,
 coalesce(sum(application_status='available'),0) AS applicationAvailable,
 coalesce(sum(qualification='pass'),0) AS qualificationPass,coalesce(sum(qualification='fail'),0) AS qualificationFail,
 coalesce(sum(qualification='unknown'),0) AS qualificationUnknown,
 coalesce(sum(opening_status IN ('historical','closed','expired')),0) AS historicalOrExpired,
 coalesce(sum(recommended=1 AND temporal_status='current'),0) AS validNewUnique,
 coalesce(sum(temporal_status='needs_recalculation'),0) AS temporalPendingCount,
 min(next_temporal_change_at) AS nextTemporalChangeAt,
 coalesce(sum(EXISTS(SELECT 1 FROM rows r JOIN selected other ON other.job_id=json_extract(r.value,'$.otherJobId')
 WHERE r.collection='jobRelations' AND r.owner_id=s.owner_id AND r.job_id=s.job_id AND json_extract(r.value,'$.relation')='possible')),0) AS suspectedDuplicates
 FROM selected s`;

test('activity member routing preserves every quality field, temporal boundary and owner-local relation set', () => {
 const db=new DatabaseSync(':memory:');
 try {
  db.exec(`CREATE TABLE rows(collection TEXT,id TEXT,owner_id TEXT,job_id TEXT,run_id TEXT,fact_hash TEXT,status TEXT,value TEXT,PRIMARY KEY(collection,id));
   CREATE TABLE package_keys(id TEXT PRIMARY KEY,state TEXT);
   CREATE INDEX rows_run ON rows(collection,owner_id,run_id,id);
   CREATE INDEX rows_job ON rows(collection,owner_id,job_id,id);
   INSERT INTO package_keys VALUES('A','active'),('B','active'),('hidden','trashed');`);
  const from='2026-10-10T00:00:00.000Z', exact='2026-10-13T00:00:00.000Z', boundary='2026-10-13T00:00:00.001Z';
  const insert=db.prepare('INSERT INTO rows VALUES(?,?,?,?,?,?,?,?)');
  const period=overrides=>({from,until:null,qualification:'pass',recommended:1,openingStatus:'open',applicationStatus:'available',temporalStatus:'current',...overrides});
  const projection=(id,overrides={},owner='A',factHash='fact')=>insert.run('jobProjections',id,owner,id,null,factHash,null,JSON.stringify({bodyVerified:true,temporalPeriods:[period({})],...overrides}));
  projection('good',{temporalPeriods:[period({until:boundary}),period({from:boundary,recommended:0,applicationStatus:'unknown'})]});
  projection('conflict',{temporalPeriods:[period({recommended:0})]});
  projection('unknown',{bodyVerified:false,temporalPeriods:[period({qualification:'unknown',recommended:0,openingStatus:'unknown',applicationStatus:'unknown'})]});
  projection('fail',{temporalPeriods:[period({qualification:'fail',recommended:0})]});
  projection('expired',{temporalPeriods:[period({recommended:0,openingStatus:'expired',applicationStatus:'unavailable'})]});
  projection('historical',{temporalPeriods:[period({qualification:'unknown',recommended:0,openingStatus:'historical',applicationStatus:'unknown'})]});
  projection('closed',{temporalPeriods:[period({qualification:'fail',recommended:0,openingStatus:'closed',applicationStatus:'unavailable'})]});
  projection('pending',{temporalPeriods:[period({temporalStatus:'needs_recalculation'})]});
  projection('without-fact',{},'A',null);
  projection('outside');projection('B-only',{},'B');projection('hidden-only',{},'hidden');
  const member=(owner,root,id,ordinal)=>{
   const metadata=recordMetadata('activityJobIds','member-'+ordinal,id,{ownerPackageId:owner,runId:root});
   assert.equal(metadata.jobId,id);
   insert.run('activityJobIds','member-'+ordinal,owner,metadata.jobId,root,null,null,JSON.stringify(id));
  };
  const ids=['good','good','conflict','unknown','fail','expired','historical','closed','pending','without-fact','no-projection','B-only'];
  ids.forEach((id,i)=>member('A','main',id,i));
  member('A','only-good','good',100);member('B','main','good',101);member('B','main','B-only',102);member('hidden','main','hidden-only',103);
  for(const [id,jobId,otherJobId] of [['r1','good','conflict'],['r2','good','conflict'],['r3','conflict','good'],['r4','good','outside'],['r5','good','B-only']])insert.run('jobRelations',id,'A',jobId,null,null,null,JSON.stringify({relation:'possible',otherJobId}));
  insert.run('observations','observation','A','good','slice',null,null,'{}');
  const queries=createSqliteJobQueries({db}), original=db.prepare(originalSql);
  const compare=input=>{
   const at=new Date(input.asOf).toISOString(), owner=input.ownerPackageId;
   const row={...original.get(at,at,owner,input.runId||null,owner,input.runId||null,input.activityId||null,owner,input.activityId||null)};
   const expected={...row,total:row.uniqueRecords,verifiedRecommendationCount:row.validNewUnique,openCount:row.open,asOf:at};
   const result=queries.queryJobQuality(input);assert.deepEqual(result,expected);return result;
  };
  for(const asOf of [from,exact,boundary]) {
   const main=compare({ownerPackageId:'A',activityId:'main',asOf});
   assert.equal(main.uniqueRecords,8);assert.equal(main.validNewUnique,asOf===boundary?0:1);assert.equal(main.temporalPendingCount,1);assert.equal(main.suspectedDuplicates,2);
   assert.equal(main.nextTemporalChangeAt,asOf===boundary?null:boundary);
   assert.equal(compare({ownerPackageId:'A',activityId:'only-good',asOf}).suspectedDuplicates,0);
   assert.equal(compare({ownerPackageId:'B',activityId:'main',asOf}).uniqueRecords,1);
   assert.equal(compare({ownerPackageId:'hidden',activityId:'main',asOf}).uniqueRecords,0);
   for(let i=0;i<8;i++)assert.equal(compare({ownerPackageId:'A',activityId:'empty-'+i,asOf}).uniqueRecords,0);
   compare({ownerPackageId:'A',runId:'slice',asOf});compare({ownerPackageId:'A',asOf});compare({ownerPackageId:'A',activityId:'',asOf});
  }
  let captured;
  createSqliteJobQueries({db,statement:sql=>({get(...bindings){captured=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...bindings);return db.prepare(sql).get(...bindings);}})}).queryJobQuality({ownerPackageId:'A',activityId:'empty-0',asOf:exact});
  assert.ok(captured.some(row=>/SEARCH a USING INDEX rows_run .*collection=\? AND owner_id=\? AND run_id=\?/.test(row.detail)));
  assert.ok(captured.some(row=>/SEARCH p USING INDEX rows_job .*collection=\? AND owner_id=\? AND job_id=\?/.test(row.detail)));
 } finally { db.close(); }
});
