export function createSourceBudget({maxRequests=120,maxDetails=20}={}) {
 for(const n of [maxRequests,maxDetails])if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid source budget');
 let requests=0;const details=new Set(),byKind={};
 return {claimRequest(kind='request'){if(requests>=maxRequests)throw Error('budget_exhausted: requests');requests++;byKind[kind]=(byKind[kind]||0)+1;},claimDetail(key){if(details.has(key))return;if(details.size>=maxDetails)throw Error('budget_exhausted: details');details.add(key);},snapshot(){return {requests,details:details.size,maxRequests,maxDetails,byKind:{...byKind}};}};
}
