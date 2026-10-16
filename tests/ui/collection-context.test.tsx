import test from "node:test";
import assert from "node:assert/strict";
import { renderApp, syntheticApi } from "../helpers/react-fixture";
import { waitFor, act, render, cleanup } from "@testing-library/react";
import {
  VersionProvider,
  useVersionContext,
} from "../../ui/src/app/VersionContext";
import {
  CollectionProvider,
  useCollectionActivity,
} from "../../ui/src/app/CollectionContext";
import { deriveActivityView } from "../../ui/src/features/workbench/activity-view";
import type { ApiClient } from "../../ui/src/lib/types";

const paused = {
  runId: "shared-root-A",
  collectionRole: "collection_root",
  ownerPackageId: "A",
  targetSnapshot: { revisionId: "t1@1" },
  collectionProgress: {
    status: "paused",
    revision: 2,
    limits: { maxRequests: 400, maxCostCny: 10 },
    units: {},
    activeSliceRunId: null,
  },
};

test("first activity read failure can be retried without changing version or reloading", async (t) => {
  let reads = 0;
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) => {
      if (p === "/collections") {
        reads++;
        if (reads === 1) throw new Error("合成暂时读取失败");
        return { collections: [] };
      }
      return syntheticApi(p, o);
    },
  });
  const retry = await f.screen.findByRole("button", {
    name: "重新读取采集活动",
  });
  assert.equal(
    (f.screen.getByRole("button", { name: "更新岗位" }) as HTMLButtonElement)
      .disabled,
    true,
  );
  await f.user.click(retry);
  await waitFor(() =>
    assert.equal(
      (f.screen.getByRole("button", { name: "更新岗位" }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  assert.equal(reads, 2);
  assert.equal(
    f.screen.queryByRole("button", { name: "重新读取采集活动" }),
    null,
  );
  assert.deepEqual(
    f.apiCalls.filter((c) => c.path === "/collections").at(-1)?.scope,
    { packageId: "A", targetRevisionId: "t1@1" },
  );
});
test("header and workbench share the current version root without extra queries", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections" ? { collections: [paused] } : syntheticApi(p, o),
  });
  await f.screen.findByText("持续采集活动");
  assert.equal(
    Boolean(f.screen.queryByRole("region", { name: "当前版本任务" })),
    true,
  );
  assert.equal(f.apiCalls.filter((c) => c.path === "/collections").length, 1);
});

test("same-version page navigation keeps the shared activity and initial query", async (t) => {
  // Background polling has a separate clock from navigation; slow rendering
  // must not be mistaken for a second initial query.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections" ? { collections: [paused] } : syntheticApi(p, o),
  });
  await f.screen.findByText("持续采集活动");
  await f.user.click(f.screen.getByRole("link", { name: "岗位库" }));
  await f.screen.findByRole("heading", { name: "岗位库" });
  await f.user.click(f.screen.getByRole("link", { name: "工作台" }));
  await f.screen.findByText("持续采集活动");
  assert.equal(f.apiCalls.filter((c) => c.path === "/collections").length, 1);
  await act(async () => t.mock.timers.tick(2000));
  await waitFor(() =>
    assert.equal(f.apiCalls.filter((c) => c.path === "/collections").length, 2),
  );
});

test("all-target and missing scope never query private collections", async (t) => {
  const f = await renderApp(t, { route: "#/workbench?allTargets=true" });
  await f.screen.findByRole("heading", { name: "工作台" });
  await act(async () => new Promise((resolve) => setImmediate(resolve)));
  assert.equal(f.apiCalls.filter((c) => c.path === "/collections").length, 0);
});

test("late version A collection response cannot replace version B", async (t) => {
  let releaseA!: (value: unknown) => void;
  const aResponse = new Promise((resolve) => (releaseA = resolve));
  const f = await renderApp(t, {
    route: "#/workbench?packageId=A&targetRevisionId=t1%401",
    apiHandler: (p, o) =>
      p === "/collections"
        ? o.scope && "packageId" in o.scope && o.scope.packageId === "A"
          ? aResponse
          : {
              collections: [
                {
                  ...paused,
                  runId: "B_CURRENT_ROOT",
                  ownerPackageId: "B",
                  targetSnapshot: { revisionId: "t2@1" },
                },
              ],
            }
        : syntheticApi(p, o),
  });
  await f.selectTarget({ packageId: "B", targetRevisionId: "t2@1" });
  await f.user.click(
    await f.screen.findByRole("button", { name: "高级计数与额度" }),
  );
  await f.screen.findByText(/B_CURRENT_ROOT/);
  await act(async () =>
    releaseA({ collections: [{ ...paused, runId: "A_PRIVATE_ACTIVITY" }] }),
  );
  await waitFor(() =>
    assert.equal(Boolean(f.screen.queryByText(/A_PRIVATE_ACTIVITY/)), false),
  );
});

test("root status is authoritative and a stale child cannot supply the phase", () => {
  assert.equal(
    deriveActivityView(paused, {
      status: "completed",
      runId: "old",
      phase: "finished",
    }).status,
    "paused",
  );
  assert.equal(
    deriveActivityView(paused, { runId: "old", phase: "finished" }).phase,
    null,
  );
  assert.equal(
    deriveActivityView(
      {
        ...paused,
        collectionProgress: {
          ...paused.collectionProgress,
          activeSliceRunId: "current",
        },
      },
      { runId: "current", phase: "details" },
    ).phase,
    "details",
  );
});

test("adopt invalidates an in-flight older list and explicit refresh queues one non-overlapping read", async (t) => {
  let state!: ReturnType<typeof useCollectionActivity>;
  const responses: ((value: unknown) => void)[] = [];
  let count = 0;
  const api = {
    request: (path: string) =>
      path === "/collections"
        ? (++count, new Promise((resolve) => responses.push(resolve)))
        : Promise.resolve(syntheticApi(path)),
  } as ApiClient;
  function Consumer() {
    state = useCollectionActivity();
    return <p>{state.activity?.collectionProgress.status ?? "empty"}</p>;
  }
  window.history.replaceState(
    null,
    "",
    "http://localhost/#/jobs?packageId=A&targetRevisionId=t1%401",
  );
  const view = render(
    <VersionProvider api={api}>
      <CollectionProvider api={api}>
        <Consumer />
      </CollectionProvider>
    </VersionProvider>,
  );
  t.after(() => {
    view.unmount();
    cleanup();
  });
  await waitFor(() => assert.equal(count, 1));
  let refresh!: Promise<void>;
  await act(async () => {
    state.adopt(paused, { packageId: "A", targetRevisionId: "t1@1" });
    refresh = state.refresh();
    void state.refresh();
  });
  assert.equal(count, 1);
  await act(async () =>
    responses[0]({
      collections: [
        {
          ...paused,
          collectionProgress: {
            ...paused.collectionProgress,
            status: "collecting",
          },
        },
      ],
    }),
  );
  assert.equal(state.activity?.collectionProgress.status, "paused");
  await waitFor(() => assert.equal(count, 2));
  await act(async () => {
    responses[1]({ collections: [paused] });
    await refresh;
  });
  assert.equal(count, 2);
  assert.equal(state.loading, false);
});

test("first A generation adopt cannot replace the state after A to B to A", async (t) => {
  let state!: ReturnType<typeof useCollectionActivity>;
  let version!: ReturnType<typeof useVersionContext>;
  const api = {
    request: (path: string) =>
      Promise.resolve(
        path === "/collections" ? { collections: [] } : syntheticApi(path),
      ),
  } as ApiClient;
  function Consumer() {
    state = useCollectionActivity();
    version = useVersionContext();
    return null;
  }
  window.history.replaceState(
    null,
    "",
    "http://localhost/#/jobs?packageId=A&targetRevisionId=t1%401",
  );
  const view = render(
    <VersionProvider api={api}>
      <CollectionProvider api={api}>
        <Consumer />
      </CollectionProvider>
    </VersionProvider>,
  );
  t.after(() => {
    view.unmount();
    cleanup();
  });
  await waitFor(() => assert.ok(state.lastFetchedAt));
  const oldAdopt = state.adopt;
  await act(async () =>
    version.select({ packageId: "B", targetRevisionId: "t2@1" }),
  );
  await act(async () =>
    version.select({ packageId: "A", targetRevisionId: "t1@1" }),
  );
  await act(async () =>
    oldAdopt(paused, { packageId: "A", targetRevisionId: "t1@1" }),
  );
  assert.equal(state.activity, null);
  await act(async () =>
    state.adopt(paused, { packageId: "A", targetRevisionId: "t1@1" }),
  );
  assert.equal(state.activity?.collectionProgress.status, "paused");
});
