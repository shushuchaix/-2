import { businessScope } from "../../src/server/package-business-routes.mjs";
import { identifier } from "../../src/server/validation.mjs";
import { publicCollectionUrl } from "../collection/network-policy.mjs";
import { buildBossOperation } from "../../src/sources/boss/protocol.mjs";
import { bossCityCode } from "../../src/sources/boss/cities.mjs";
import {
  safeSourceIssues,
  safeSourceDiagnosticRefs,
} from "../../src/sources/source-status.mjs";
import { recordDiagnostic } from "../../src/infrastructure/diagnostics/log.mjs";
export function createCollectionCommands({
  browser,
  context,
  sessionStore,
  forgetSession,
}) {
  const commands = {};
  const methods = {
    "collection:boss-probe": "collection.bossProbe",
    "collection:status": "collection.status",
    "collection:capabilities": "collection.capabilities",
    "collection:login": "collection.login",
    "collection:verify": "collection.verify",
    "collection:clear": "collection.clear",
  };
  const register = (channel, action) => {
    commands[methods[channel]] = action;
  };
  const guarded = (fn) => fn;
  register(
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
      let diagnosticSignal,
        diagnosticGuard,
        failure,
        probeAttempted = false;
      return context.collectionService
        .withDiagnosticContext({ ref, requestId }, async (ctx) => {
          const unit = ctx.bossUnit;
          const operation = buildBossOperation({
            kind: "boss.search",
            query: unit?.query?.keyword || ctx.targetSnapshot?.roles?.[0],
            city:
              bossCityCode(
                unit?.query?.city || ctx.targetSnapshot?.cities?.[0],
              ) || undefined,
            page: 1,
          });
          diagnosticSignal = ctx.signal;
          diagnosticGuard = ctx.token && { ref, token: { ...ctx.token } };
          try {
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
          } catch (error) {
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
                "collection_route_forbidden",
              ].includes(error?.code)
            )
              throw error;
            // Persist safe metadata while the original diagnostic lease is live.
            const status = probeAttempted
              ? null
              : await sessionStore.getStatus({
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
                        requestId: safeSourceDiagnosticRefs(error).requestId,
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
                ...safeSourceDiagnosticRefs(error),
                signal: diagnosticSignal,
                collectionGuard: diagnosticGuard,
                operationLease: ctx.operationLease,
              });
            diagnosticSignal?.throwIfAborted();
            failure = {
              error,
              status,
              result: {
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
                  [
                    {
                      code: error.code,
                      ...safeSourceDiagnosticRefs(error),
                      diagnosticId,
                    },
                  ],
                  "boss",
                  "boss",
                ),
              },
            };
            throw error;
          }
        })
        .catch(async (error) => {
          diagnosticSignal?.throwIfAborted();
          if (failure?.error !== error) throw error;
          const status =
            failure.status ||
            (await sessionStore.getStatus({ scope: ref.scope, sessionRef }));
          diagnosticSignal?.throwIfAborted();
          return {
            ...status,
            ...failure.result,
            state: status.state === "expired" ? "expired" : "unverified",
          };
        });
    }),
  );
  register(
    "collection:status",
    guarded((input) =>
      sessionStore.getStatus({
        scope: businessScope(input),
        sessionRef: identifier(input.sessionRef),
      }),
    ),
  );
  register(
    "collection:capabilities",
    guarded(() => ({
      available: Boolean(browser),
      canRemember: sessionStore?.available() === true,
    })),
  );
  register(
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
  register(
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
  register(
    "collection:clear",
    guarded(async (input) => {
      const scope = businessScope(input),
        sessionRef = identifier(input.sessionRef);
      const result = await browser.clearSession({ scope, sessionRef });
      if (result.status === "clean") await forgetSession({ scope, sessionRef });
      return result;
    }),
  );
  return Object.freeze(commands);
}
