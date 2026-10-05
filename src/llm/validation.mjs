import {contentHash} from '../infrastructure/storage/repository.mjs';
export function evaluationCacheKey({jdHash,profileRevisionId,targetRevisionId,promptVersion,ruleVersion,modelFingerprint}){return contentHash({jdHash,profileRevisionId,targetRevisionId,promptVersion,ruleVersion,modelFingerprint});}
export function validateModelResults(raw,{records}){
 const known=new Map(records.map(r=>[r.jobId,r])),valid=[],invalidIds=new Set(),issues=[];const rows=Array.isArray(raw?.results)?raw.results:[],counts=new Map();for(const row of rows)if(row&&typeof row.jobId==='string')counts.set(row.jobId,(counts.get(row.jobId)||0)+1);
 for(const row of rows){if(!row||!known.has(row.jobId)){issues.push({code:'unknown_model_job_id',jobId:row?.jobId||null});continue;}const record=known.get(row.jobId),source=[record.title,record.description].filter(Boolean).join('\n');const strings=value=>Array.isArray(value)&&value.every(s=>typeof s==='string'&&s.length<=2000);const evidence=Array.isArray(row.evidence)&&row.evidence.every(e=>e&&typeof e.excerpt==='string'&&e.excerpt.trim()&&source.includes(e.excerpt));
 if(counts.get(row.jobId)!==1||!Number.isFinite(row.score)||row.score<0||row.score>100||!strings(row.reasons)||!strings(row.gaps)||!evidence){invalidIds.add(row.jobId);issues.push({code:'invalid_model_result',jobId:row.jobId});continue;}valid.push(row);}
 const validIds=new Set(valid.map(v=>v.jobId));return {valid,invalidIds:[...invalidIds],missingIds:records.filter(r=>!validIds.has(r.jobId)&&!invalidIds.has(r.jobId)).map(r=>r.jobId),issues};
}
