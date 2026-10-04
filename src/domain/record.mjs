import { JOB_KINDS,JOB_TYPES } from './contracts.mjs';
export function normalizeRecord(input) {
 const record=structuredClone(input);const sourceId=record.sourceId||record.source||'manual';
 const rawType=record.jobType||'';const jobType=JOB_TYPES.includes(rawType)?rawType:/实习/.test(rawType)?'internship':/校招|应届|校园/.test(rawType)?'campus':/社招|社会/.test(rawType)?'social':'unknown';
 return {...record,sourceId,siteId:record.siteId||record.extra?.university||sourceId,sourceRecordId:record.sourceRecordId??null,identityScope:record.identityScope||record.siteId||sourceId,
 kind:JOB_KINDS.includes(record.kind)?record.kind:record.isCompanyLead?'company_campaign':(record.isWebLead||record.isArticleLead)?'recruitment_notice':'job',title:String(record.title||''),company:record.company||null,cities:record.cities||record.extra?.cityList||[record.city].filter(Boolean),jobType,
 description:record.description||null,degree:record.degree||record.education||null,graduationYear:record.graduationYear||record.extra?.graduationYear||null,evidence:record.evidence||[],parserVersion:record.parserVersion||'legacy-1'};
}
