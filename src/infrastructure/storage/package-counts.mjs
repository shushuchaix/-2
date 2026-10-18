export const PACKAGE_COUNT_COLLECTIONS = Object.freeze(['profiles','targets','jobs','observations','evaluations','runs','applications','events','files']);

/** Only aggregate integers are decoded, including embedded private entities. */
export function countPackageRows(store,packageId){
  const count=collection=>store.aggregateRows({collection,ownerPackageId:packageId,operation:'count'}).groups[0]?.value||0;
  const counts=Object.fromEntries(PACKAGE_COUNT_COLLECTIONS.map(collection=>[collection,count(collection)]));
  counts.profiles+=count('profileCopies');
  counts.events+=count('runEvents')+count('applicationEvents')+count('recoveryRecords');
  return counts;
}
