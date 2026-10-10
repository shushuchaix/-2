import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { mountWorkbenchPage } from "../../public/js/pages/workbench.js";
test("workbench follows only the selected frozen revision and excludes unassigned legacy runs", async () => {
  const targets = [1, 2].map((n) => ({
    targetId: "t1",
    revisionId: "t1@" + n,
    profileRevisionId: "p1@1",
    enabled: true,
    roles: ["合成岗位"],
  }));
  const connected = [];
  const runs = [
    {
      runId: "other-run",
      status: "running",
      createdAt: "2026-10-08",
      targetSnapshot: { targetId: "t1", revisionId: "t1@2" },
    },
    { runId: "unassigned-legacy", status: "running", createdAt: "2026-10-07" },
  ];
  const f = uiFixture((path) =>
    path === "/targets"
      ? { targets }
      : path === "/profiles"
        ? { profiles: [{ revisionId: "p1@1" }] }
        : path.startsWith("/jobs")
          ? { items: [], total: 0 }
          : path.startsWith("/runs?")
            ? { runs }
            : path === "/runs/other-run"
              ? runs[0]
              : {},
  );
  f.api.streamRun = async (id, { signal }) => {
    connected.push(id);
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
  };
  f.store.dispatch({ type: "target", id: "t1", revisionId: "t1@1" });
  const page = mountWorkbenchPage(f);
  await page.ready;
  await f.settle();
  assert.deepEqual(connected, []);
  assert.equal(f.root.querySelector("#cancelRun").disabled, true);
  const select = f.root.querySelector("#workbenchTarget");
  select.value = "t1@2";
  select.dispatchEvent(new f.document.defaultView.Event("change"));
  await f.settle();
  assert.deepEqual(connected, ["other-run"]);
  assert.equal(f.store.getState().run?.runId, "other-run");
  assert.equal(f.root.querySelector("#cancelRun").disabled, false);
  page.destroy();
});
test("no target guides confirmation and partial runs show real counts", async () => {
  const f = uiFixture((p) =>
    p === "/targets"
      ? {
          targets: [
            {
              targetId: "t1",
              revisionId: "t1@1",
              revision: 1,
              profileRevisionId: "p1@1",
              enabled: true,
              roles: ["软件开发"],
            },
          ],
        }
      : p.startsWith("/jobs?")
        ? { items: [], total: 0 }
        : p === "/runs"
          ? { runId: "r1", status: "queued" }
          : p === "/runs/r1"
            ? {
                runId: "r1",
                status: "partial",
                counts: { newForTarget: 2 },
                coverage: [{ status: "failed", siteId: "s1" }],
                issues: [],
                usage: {},
              }
            : { runs: [] },
  );
  f.api.streamRun = async (id, { onEvent }) => {
    const event = {
      runId: id,
      seq: 1,
      type: "done",
      payload: { status: "partial", counts: { newForTarget: 2 } },
    };
    await onEvent(event);
    await onEvent(event);
  };
  const page = mountWorkbenchPage(f);
  await page.ready;
  assert.equal(f.root.querySelector("#workbenchTarget option")?.value, "t1@1");
  f.root.querySelector("#startRun").click();
  await f.settle();
  assert.ok(f.root.textContent.includes("部分来源失败"));
  assert.equal(f.store.getState().run.counts.newForTarget, 2);
  assert.equal(f.root.querySelector("#cancelRun").disabled, true);
  page.destroy();
  const empty = uiFixture((p) =>
    p === "/targets"
      ? { targets: [] }
      : p.startsWith("/jobs?")
        ? { items: [], total: 0 }
        : { runs: [] },
  );
  const ep = mountWorkbenchPage(empty);
  await ep.ready;
  assert.ok(empty.root.textContent.includes("先确认简历"));
  ep.destroy();
});
