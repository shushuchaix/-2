import {randomUUID} from 'node:crypto';
import {packageFixture} from './package-fixture.mjs';
import {createJobService} from '../../src/application/job-service.mjs';
import {createExportService} from '../../src/application/export-service.mjs';
import {createImportService} from '../../src/application/import-service.mjs';
import {createWorkspaceOperationGate} from '../../src/application/workspace-operations.mjs';
import {createLegacyAssignmentService} from '../../src/application/legacy-assignment-service.mjs';
export async function packageBusinessFixture(t,options={}) {
  const f=await packageFixture(t,options);
  const wire=()=>{
    f.operationGate=createWorkspaceOperationGate({repository:f.repository});
    f.assignment=createLegacyAssignmentService({repository:f.repository});
    f.jobs=createJobService({repository:f.repository});
    f.exportService=createExportService({repository:f.repository});
    f.importService=createImportService({repository:f.repository,jobService:f.jobs,operationGate:f.operationGate,request:async()=>{throw Error('Synthetic import forbids network');}});
  };wire();
  const reopen=f.reopen;f.reopen=async()=>{await reopen();wire();return f;};
  f.ingest=async(scope,records)=>{
    const runId='synthetic-'+randomUUID();
    await f.repository.mutateWorkspace(w=>{const target=Object.values(w.targets).flat().find(v=>v.revisionId===scope.targetRevisionId);w.runs[runId]={runId,recordId:randomUUID(),ownerPackageId:scope.packageId,targetSnapshot:structuredClone(target),status:'completed',events:[],lastSeq:0,counts:{},usage:{},issues:[],createdAt:new Date(f.clock.now()).toISOString()};});
    return (await f.jobs.ingestRecords({runId,records,scope})).jobIds;
  };
  return f;
}
