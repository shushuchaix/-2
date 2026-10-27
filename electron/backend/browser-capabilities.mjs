import { createCollectionLedger } from "../../src/application/collection-ledger.mjs";

// All writes go through the formal backend repository. Scope checks run even
// when the selected package has no browser settings or the command is a no-op.
export function createBrowserCapabilities(context) {
  const repository = context.repository;
  const ledger = createCollectionLedger({ repository });
  const selection = (scope) => ({
    select: [{ collection: "packages", ids: [scope.packageId] }],
    metaKeys: [],
  });
  const remember = async ({ scope, platform, sessionRef }) => {
    await repository.transaction(
      selection(scope),
      (tx) => {
        const pkg = tx.getRow({ collection: "packages", id: scope.packageId });
        pkg.collectionSettings ||= {
          sourceOverrides: {},
          sessionRefs: {},
          refreshEnabled: false,
        };
        pkg.collectionSettings.sessionRefs[platform] = sessionRef;
        tx.putRow({ collection: "packages", id: scope.packageId, value: pkg });
        return { remembered: true };
      },
      { scope },
    );
    return { remembered: true };
  };
  const forget = async ({ scope, sessionRef }) => {
    await repository.transaction(
      selection(scope),
      (tx) => {
        const pkg = tx.getRow({ collection: "packages", id: scope.packageId });
        for (const [platform, saved] of Object.entries(
          pkg.collectionSettings?.sessionRefs || {},
        )) {
          if (saved !== sessionRef) continue;
          delete pkg.collectionSettings.sessionRefs[platform];
          for (const key of Object.keys(
            pkg.collectionSettings.sourceVerification || {},
          ))
            if (key.startsWith(platform + "/"))
              delete pkg.collectionSettings.sourceVerification[key];
        }
        tx.putRow({ collection: "packages", id: scope.packageId, value: pkg });
        return { forgotten: true };
      },
      { scope },
    );
    return { forgotten: true };
  };
  return {
    forget,
    handlers: {
      "browser.scope.assert": async ({ scope }) => {
        await repository.getRow(
          { collection: "packages", id: scope.packageId },
          { scope },
        );
        return { valid: true };
      },
      "browser.session.remember": remember,
      "browser.session.forget": forget,
      ...Object.fromEntries(
        ["snapshot", "reserve", "reserveBatch", "settle", "settleBatch"].map(
          (name) => [
            "browser.ledger." + name,
            async (input) => (await ledger[name](input)) ?? null,
          ],
        ),
      ),
    },
  };
}
