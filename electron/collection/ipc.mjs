import { guardDesktopSender } from "../credentials.mjs";
import { businessScope } from "../../src/server/package-business-routes.mjs";
import { identifier } from "../../src/server/validation.mjs";
import { publicCollectionUrl } from "./network-policy.mjs";
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
    guarded((input) =>
      browser.clearSession({
        scope: businessScope(input),
        sessionRef: identifier(input.sessionRef),
      }),
    ),
  );
}
