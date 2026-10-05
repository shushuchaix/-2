import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import { submit } from "../helpers/dom.mjs";
import { mountApplicationsPage } from "../../public/js/pages/applications.js";
import { localDate } from "../../public/js/format.js";
test("application note clears and failed save retains unsaved input while stored status stays unchanged", async () => {
  let saved = { status: "applied", note: "旧备注", events: [] },
    fail = false;
  const f = uiFixture((p, o) => {
    if (p === "/profiles") return { profiles: [] };
    if (p.startsWith("/jobs?"))
      return {
        items: [
          {
            jobId: "j1",
            title: "合成岗位",
            company: "公司",
            application: saved,
          },
        ],
        total: 1,
      };
    if (p === "/jobs/j1")
      return {
        job: { jobId: "j1", canonical: { title: "合成岗位" } },
        application: saved,
      };
    if (p === "/applications/j1") {
      if (fail) throw Error("磁盘写入失败");
      saved = { ...saved, ...o.body };
      return saved;
    }
    return {};
  });
  const page = mountApplicationsPage(f);
  await page.ready;
  f.root.querySelector("[data-edit-application]").click();
  await f.settle();
  f.root.querySelector("#applicationNote").value = "";
  submit(f.document, f.root.querySelector("#applicationForm"));
  await f.settle();
  assert.equal(saved.note, "");
  assert.equal(
    f.calls.findLast((x) => x.path === "/applications/j1").body.note,
    "",
  );
  fail = true;
  f.root.querySelector("#applicationStatus").value = "offer";
  submit(f.document, f.root.querySelector("#applicationForm"));
  await f.settle();
  assert.equal(saved.status, "applied");
  assert.ok(f.root.textContent.includes("未保存"));
  assert.equal(f.root.querySelector("#applicationStatus").value, "offer");
  assert.equal(localDate("2026-10-05"), "2026-10-05");
  page.destroy();
});
