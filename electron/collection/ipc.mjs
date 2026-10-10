import { guardDesktopSender } from "../credentials.mjs";
import { businessScope } from "../../src/server/package-business-routes.mjs";
import { identifier } from "../../src/server/validation.mjs";
import { publicCollectionUrl } from "./network-policy.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
import { bossCityCode } from "../../src/sources/boss/cities.mjs";
import { assertScope } from "../../src/domain/packages.mjs";
export function registerCollectionIpc({
  ipcMain,
  browser,
  context,
  getWindow,
  getOrigin,
  sessionStore,
}) {
  const guarded = (fn) => guardDesktopSender({ getWindow, getOrigin }, fn);
  ipcMain.handle(
    "collection:boss-probe",
    guarded(async (input) => {
      if (
        !input ||
        Object.keys(input).some(
          (k) =>
            ![
              "scope",
              "activityId",
              "sessionRef",
              "requestId",
              "clearRisk",
            ].includes(k),
        ) ||
        (input.clearRisk !== undefined && typeof input.clearRisk !== "boolean")
      )
        throw Object.assign(Error("Boss 核验参数无效。"), {
          code: "validation_failed",
        });
      const ref = {
        scope: businessScope(input),
        activityId: identifier(input.activityId),
      };
      const sessionRef = identifier(input.sessionRef),
        requestId = identifier(input.requestId);
      const entry = await sessionStore.get({ scope: ref.scope, sessionRef });
      if (entry.platform !== "boss")
        throw Object.assign(Error("会话与来源不匹配。"), {
          code: "collection_session_scope",
        });
      const root = await context.collectionService.get(ref);
      const unit = Object.values(root.collectionProgress.units).find(
        (u) => u.sourceId === "boss",
      );
      const keyword = unit?.query?.keyword || root.targetSnapshot.roles?.[0];
      const operation = buildBossOperation({
        kind: "boss.search",
        query: keyword,
        city: bossCityCode(
          unit?.query?.city || root.targetSnapshot.cities?.[0],
        ),
        page: 1,
      });
      return context.collectionService.withDiagnosticContext(
        { ref, requestId },
        async (ctx) => {
          if (input.clearRisk === true) {
            await browser.recoverBossSession({
              ...ctx,
              ref,
              sessionRef,
              operation,
            });
            await context.collectionService.resolveBossRisk({ ...ctx, ref });
          }
          const result = await context.sourceService.probeScopedSource({
            scope: ref.scope,
            sourceId: "boss",
            siteId: "boss",
            ref,
          });
          const status = await sessionStore.getStatus({
            scope: ref.scope,
            sessionRef,
          });
          if (result.status === "ready" && !status.riskBlocked)
            await context.collectionService.resolveBossRisk({ ...ctx, ref });
          return {
            ...status,
            sourceStatus: result.status,
            state: result.status === "ready" ? "verified" : "unverified",
          };
        },
      );
    }),
  );
  ipcMain.handle(
    "collection:status",
    guarded((input) =>
      sessionStore.getStatus({
        scope: businessScope(input),
        sessionRef: identifier(input.sessionRef),
      }),
    ),
  );
  ipcMain.handle(
    "collection:capabilities",
    guarded(() => ({
      available: Boolean(browser),
      canRemember: sessionStore?.available() === true,
    })),
  );
  ipcMain.handle(
    "collection:login",
    guarded(async (input) => {
      const scope = businessScope(input);
      const ref = {
        scope,
        activityId: input.activityId ? identifier(input.activityId) : undefined,
      };
      if (ref.activityId) await context.collectionService.get(ref);
      return browser.openLogin({
        ref,
        platform: input.platform,
        accountRef: input.accountRef,
        remember: input.remember ?? false,
        testUrl: input.testUrl
          ? publicCollectionUrl(input.testUrl).href
          : undefined,
      });
    }),
  );
  ipcMain.handle(
    "collection:verify",
    guarded(async (input) => {
      const ref = {
          scope: businessScope(input),
          activityId: identifier(input.activityId),
        },
        sessionRef = identifier(input.sessionRef),
        testUrl = publicCollectionUrl(input.testUrl).href;
      return context.collectionService.withActivityContext(ref, (ctx) =>
        browser.verifySession({ ...ctx, ref, sessionRef, testUrl }),
      );
    }),
  );
  ipcMain.handle(
    "collection:clear",
    guarded(async (input) => {
      const scope = businessScope(input),
        sessionRef = identifier(input.sessionRef);
      const result = await browser.clearSession({ scope, sessionRef });
      if (result.status === "clean")
        await context.repository.mutateWorkspace((w) => {
          const pkg = assertScope(w, scope, context.repository.clock.now()),
            settings = pkg.collectionSettings;
          for (const [platform, saved] of Object.entries(
            settings?.sessionRefs || {},
          ))
            if (saved === sessionRef) {
              delete settings.sessionRefs[platform];
              for (const key of Object.keys(settings.sourceVerification || {}))
                if (key.startsWith(platform + "/"))
                  delete settings.sourceVerification[key];
            }
        });
      return result;
    }),
  );
}
