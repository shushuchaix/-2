export function computeRankingMetrics(labels,ranked){
 const map=new Map(labels.map(l=>[l.jobId,l]));const top=ranked.slice(0,10);const relevant=top.filter(r=>(map.get(r.jobId)?.relevance||0)>=2).length;
 const dcg=rows=>rows.reduce((sum,r,index)=>sum+(2**(r.relevance||0)-1)/Math.log2(index+2),0);
 const ideal=dcg([...labels].sort((a,b)=>b.relevance-a.relevance).slice(0,10));const actual=dcg(top.map(r=>map.get(r.jobId)||{relevance:0}));const confusion={};
 for(const r of ranked){const truth=map.get(r.jobId)?.qualification||'unknown',predicted=r.qualification?.status||'unknown';confusion[truth]||={pass:0,fail:0,unknown:0};confusion[truth][predicted]++;}
 const high=ranked.filter(r=>r.recommendation==='high');return {precisionAt10:top.length?relevant/top.length:0,ndcgAt10:ideal?actual/ideal:0,qualificationConfusion:confusion,incompleteHighRecommendationRate:high.length?high.filter(r=>map.get(r.jobId)?.incomplete).length/high.length:0};
}
