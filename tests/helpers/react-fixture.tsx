import { act, render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TestContext } from "node:test";
import { App } from "../../ui/src/app/App";
import { createDesktopAdapter } from "../../ui/src/lib/desktop";
import type {
  ApiClient,
  DesktopBridge,
  RequestOptions,
  Scope,
  RunEvent,
} from "../../ui/src/lib/types";
export type ApiHandler = (
  path: string,
  options: RequestOptions,
) => unknown | Promise<unknown>;
export const syntheticTargets = [
  {
    targetId: "t1",
    revisionId: "t1@1",
    packageId: "A",
    versionName: "合成目标A",
    enabled: true,
    profileSnapshot: {
      revisionId: "copy-A@1",
      text: "合成简历A",
      profile: { name: "合成人A" },
    },
  },
  {
    targetId: "t2",
    revisionId: "t2@1",
    packageId: "B",
    versionName: "合成目标B",
    enabled: true,
    profileSnapshot: {
      revisionId: "copy-B@1",
      text: "合成简历B",
      profile: { name: "合成人B" },
    },
  },
];
export function syntheticApi(path: string, _opts: RequestOptions = {}) {
  const route = path.split("?")[0];
  if (route === "/targets") return { targets: syntheticTargets };
  if (route === "/profiles")
    return {
      profiles: [
        {
          profileId: "p1",
          revisionId: "p1@1",
          packageId: "P",
          versionName: "合成简历",
          enabled: true,
          profile: { name: "合成人" },
          text: "合成教育及经历",
        },
      ],
    };
  if (route === "/sources") return { sources: [], sites: [] };
  if (route === "/settings")
    return {
      model: { baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
      budgets: { maxCostCny: 10, maxModelRequests: 1000 },
    };
  if (route === "/jobs") return { items: [], total: 0, page: 1, pageSize: 25 };
  if (route === "/runs") return { runs: [] };
  if (route === "/applications")
    return { items: [], total: 0, page: 1, pageSize: 25 };
  if (route === "/trash") return { items: [], packageCount: 0 };
  if (route === "/diagnostics/logs")
    return { items: [], logs: [], entries: [] };
  if (route === "/legacy-records") return { items: [], records: [] };
  return {};
}
export async function renderApp(
  t: TestContext,
  {
    apiHandler = syntheticApi,
    route = "#/workbench",
    desktopBridge,
  }: {
    apiHandler?: ApiHandler;
    route?: string;
    desktopBridge?: DesktopBridge;
  } = {},
) {
  window.history.replaceState(null, "", "http://localhost/" + route);
  const apiCalls: {
    path: string;
    options: RequestOptions;
    body?: unknown;
    scope?: RequestOptions["scope"];
  }[] = [];
  const invoke = (path: string, options: RequestOptions = {}) => {
    apiCalls.push({ path, options, body: options.body, scope: options.scope });
    return Promise.resolve()
      .then(() => apiHandler(path, options))
      .then((value) =>
        value === undefined ? syntheticApi(path, options) : value,
      );
  };
  const api: ApiClient = {
    request: <T,>(path: string, options?: RequestOptions) =>
      invoke(path, options) as Promise<T>,
    download: async (path, opts) => {
      const value = await invoke(path, opts);
      return value instanceof Blob ? value : new Blob([JSON.stringify(value)]);
    },
    async streamRun(id, options) {
      const events = await invoke(
        "/runs/" + id + "/events",
        options as RequestOptions,
      );
      if (Array.isArray(events))
        for (const e of events) await options.onEvent(e as RunEvent);
    },
  };
  let view: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <App api={api} desktop={createDesktopAdapter(desktopBridge)} />,
    );
  });
  t.after(() => {
    view.unmount();
    cleanup();
    window.history.replaceState(null, "", "http://localhost/");
  });
  return {
    screen,
    user: userEvent.setup(),
    apiCalls,
    api,
    unmount: () => view.unmount(),
    async selectTarget(scope: Scope) {
      const target = syntheticTargets.find(
        (x) => x.packageId === scope.packageId,
      );
      await userEvent
        .setup()
        .click(screen.getByRole("combobox", { name: "当前目标" }));
      await userEvent.setup().click(
        await screen.findByRole("option", {
          name: target?.versionName ?? scope.targetRevisionId,
        }),
      );
    },
  };
}
