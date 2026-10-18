import assert from "node:assert/strict";

// Collection heads deliberately omit private queue/cache records. Read their
// owner and root bound pages through the same formal repository contract.
export async function collectionPartRows(repository, ref, collection, part) {
  const rows = [];
  let afterId;
  do {
    const page = await repository.queryRows({
      collection,
      ownerPackageId: ref.scope.packageId,
      where: { parentId: ref.activityId, path: "collectionProgress." + part },
      limit: 200,
      ...(afterId ? { afterId } : {}),
    }, { scope: ref.scope });
    rows.push(...page.rows);
    if (!page.hasMore) break;
    assert.ok(page.nextCursor && page.nextCursor !== afterId, "private part pagination must advance");
    afterId = page.nextCursor;
  } while (true);
  return rows;
}
