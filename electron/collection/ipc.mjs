import { guardDesktopSender } from "../credentials.mjs";
import { businessScope } from "../../src/server/package-business-routes.mjs";
import { identifier } from "../../src/server/validation.mjs";
import { publicCollectionUrl } from "./network-policy.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
import { bossCityCode } from "../../src/sources/boss/cities.mjs";
import { assertScope } from "../../src/domain/packages.mjs";
import { safeSourceIssues } from "../../src/sources/source-status.mjs";
import { recordDiagnostic } from "../../src/infrastructure/diagnostics/log.mjs";
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
      let diagnosticSignal,
        diagnosticGuard,
        probeAttempted = false;
      return context.collectionService
        .withDiagnosticContext({ ref, requestId }, async (ctx) => {
          diagnosticSignal = ctx.signal;
          diagnosticGuard = ctx.token && { ref, token: { ...ctx.token } };
          if (input.clearRisk === true) {
            await browser.recoverBossSession({
              ...ctx,
              ref,
              sessionRef,
              operation,
            });
            await context.collectionService.resolveBossRisk({ ...ctx, ref });
          }
          probeAttempted = true;
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
          diagnosticSignal?.throwIfAborted();
          if (result.status === "ready" && !status.riskBlocked)
            await context.collectionService.resolveBossRisk({ ...ctx, ref });
          return {
            ...status,
            sourceStatus: result.status,
            issues: safeSourceIssues(result.issues, "boss", "boss"),
            state: result.status === "ready" ? "verified" : "unverified",
          };
        })
        .catch(async (error) => {
          diagnosticSignal?.throwIfAborted();
          if (error?.runFatal || error?.name === "AbortError") throw error;
          if (
            ![
              "boss_account_risk",
              "boss_environment_risk",
              "boss_risk_blocked",
              "boss_auth_expired",
              "boss_login_required",
              "boss_ajax_unavailable",
              "boss_transport_failed",
              "boss_response_invalid",
              "boss_rate_limited",
              "collection_browser_timeout",
              "collection_browser_output_limit",
            ].includes(error?.code)
          )
            throw error;
          // The diagnostic has already drained and failed. Return its safe
          // owned-session state so the UI can render the latched risk immediately.
          const status = await sessionStore.getStatus({
            scope: ref.scope,
            sessionRef,
          });
          const diagnosticId =
            /^d-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
              error.diagnosticId || "",
            )
              ? error.diagnosticId
              : (
                  await recordDiagnostic(
                    context.diagnostics,
                    {
                      operation: "source.probe",
                      sourceId: "boss",
                      siteId: "boss",
                      phase: error.phase || "response",
                      outcome: "failed",
                      code: error.code,
                    },
                    error,
                  )
                )?.diagnosticId;
          diagnosticSignal?.throwIfAborted();
          if (!probeAttempted)
            await context.sourceService.recordScopedBossProbeFailure?.({
              scope: ref.scope,
              sessionRef,
              code: error.code,
              diagnosticId,
              signal: diagnosticSignal,
              collectionGuard: diagnosticGuard,
            });
          diagnosticSignal?.throwIfAborted();
          return {
            ...status,
            sourceStatus: [
              "boss_account_risk",
              "boss_environment_risk",
              "boss_risk_blocked",
              "boss_auth_expired",
              "boss_login_required",
            ].includes(error.code)
              ? "restricted"
              : "unavailable",
            issues: safeSourceIssues(
              [{ code: error.code, diagnosticId }],
              "boss",
              "boss",
            ),
            state: status.state === "expired" ? "expired" : "unverified",
          };
        });
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
        remember:
          input.platform === "boss"
            ? input.remember
            : (input.remember ?? false),
        sessionRef: input.sessionRef ? identifier(input.sessionRef) : undefined,
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
