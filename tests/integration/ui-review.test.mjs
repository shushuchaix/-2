import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { submit } from "../helpers/dom.mjs";
import { mountWorkbenchPage } from "../../public/js/pages/workbench.js";
import { mountApplicationsPage } from "../../public/js/pages/applications.js";
const targets = ["a", "b"].map((id) => ({
  targetId: id,
  revisionId: id + "@1",
  revision: 1,
  enabled: true,
  roles: [id],
}));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function selectTarget(f, id) {
  const select = f.root.querySelector("#workbenchTarget");
  select.value = id + "@1";
  select.dispatchEvent(new f.document.defaultView.Event("change"));
}

test("review 8 UI: workbench queries the selected revision as well as target", async () => {
  const f = uiFixture((p) =>
    p === "/targets"
      ? { targets }
      : p.startsWith("/jobs?")
        ? { items: [], total: 0 }
        : { runs: [] },
  );
  const page = mountWorkbenchPage(f);
  await page.ready;
  const query = new URLSearchParams(
    f.calls.find((c) => c.path.startsWith("/jobs?")).path.split("?")[1],
  );
  assert.equal(query.get("targetRevisionId"), "a@1");
  page.destroy();
});

test("review 9a: a late history response from target A cannot overwrite target B", async () => {
  const delayed = deferred();
  let pending = false;
  const f = uiFixture((p) =>
    p === "/targets"
      ? { targets }
      : p.startsWith("/jobs?")
        ? { items: [], total: 0 }
        : p === "/runs?targetId=a" && pending
          ? delayed.promise
          : {
              runs: [
                {
                  runId: p.endsWith("b") ? "b-run" : "a-run",
                  createdAt: p.endsWith("b") ? "B HISTORY" : "A HISTORY",
                  status: "completed",
                  targetSnapshot: {
                    revisionId: p.endsWith("b") ? "b@1" : "a@1",
                  },
                },
              ],
            },
  );
  const page = mountWorkbenchPage(f);
  await page.ready;
  pending = true;
  selectTarget(f, "a");
  await f.settle();
  selectTarget(f, "b");
  await f.settle();
  delayed.resolve({
    runs: [
      {
        runId: "late",
        createdAt: "LATE A HISTORY",
        status: "completed",
        targetSnapshot: { revisionId: "a@1" },
      },
    ],
  });
  await f.settle();
  assert.match(f.root.textContent, /B HISTORY/);
  assert.doesNotMatch(f.root.textContent, /LATE A HISTORY/);
  page.destroy();
});

test("review 9b: switching target detaches the old stream and rejects late events", async () => {
  let onEvent, signal;
  const waiting = deferred();
  const f = uiFixture((p) =>
    p === "/targets"
      ? { targets }
      : p.startsWith("/jobs?")
        ? { items: [], total: 0 }
        : p === "/runs"
          ? { runId: "a-run", status: "queued" }
          : { runs: [] },
  );
  f.api.streamRun = async (_id, options) => {
    onEvent = options.onEvent;
    signal = options.signal;
    await waiting.promise;
  };
  const page = mountWorkbenchPage(f);
  await page.ready;
  f.root.querySelector("#startRun").click();
  await f.settle();
  selectTarget(f, "b");
  await f.settle();
  assert.equal(signal.aborted, true);
  onEvent({
    runId: "a-run",
    seq: 1,
    type: "source",
    payload: { status: "running", counts: { newForTarget: 99 } },
  });
  assert.equal(f.store.getState().run, null);
  assert.equal(f.root.querySelector("#cancelRun").disabled, true);
  assert.equal(f.root.querySelector("#startRun").disabled, false);
  assert.ok(!f.calls.some((c) => c.path.endsWith("/cancel")));
  page.destroy();
  waiting.resolve();
  await f.settle();
});

test("review 2 UI: ambiguous applications have a separate editable pending confirmation panel", async () => {
  let application = {
    jobId: "legacy:old",
    status: "applied",
    note: "旧备注",
    legacyJobIds: ["j1", "j2"],
    events: [],
  };
  const candidates = [
    { jobId: "j1", canonical: { title: "北京岗位" } },
    { jobId: "j2", canonical: { title: "上海岗位" } },
  ];
  const f = uiFixture((p, o) =>
    p === "/profiles"
      ? { profiles: [] }
      : p.startsWith("/jobs?")
        ? { items: [], total: 0 }
        : p.startsWith("/applications/unresolved")
          ? { items: [{ application, candidateJobs: candidates }] }
          : p.startsWith("/applications/legacy")
            ? o.method === "PUT"
              ? (application = { ...application, ...o.body })
              : { application, candidateJobs: candidates }
            : {},
  );
  const page = mountApplicationsPage(f);
  await page.ready;
  assert.match(f.root.textContent, /待确认旧记录/);
  assert.match(f.root.textContent, /旧备注/);
  f.root.querySelector("[data-edit-unresolved]").click();
  await f.settle();
  assert.match(f.root.textContent, /北京岗位/);
  assert.match(f.root.textContent, /上海岗位/);
  f.root.querySelector("#applicationNote").value = "待核对关联";
  submit(f.document, f.root.querySelector("#applicationForm"));
  await f.settle();
  assert.equal(application.note, "待核对关联");
  assert.deepEqual(application.legacyJobIds, ["j1", "j2"]);
  page.destroy();
});
