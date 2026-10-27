import test from "node:test";
import assert from "node:assert/strict";
import { act, within } from "@testing-library/react";
import type { TestContext } from "node:test";
import { renderApp } from "../helpers/react-fixture";

const counts = {
  profiles: 1,
  targets: 1,
  jobs: 2,
  observations: 2,
  evaluations: 1,
  runs: 1,
  applications: 1,
  events: 2,
  files: 1,
};
const rows = [
  {
    packageId: "target-trash",
    kind: "target",
    state: "trashed",
    versionName: "合成消防方向",
    archiveId: "episode-target",
    archivedAt: "2099-01-01T00:00:00Z",
    purgeAt: "2099-01-04T00:00:00Z",
    counts,
  },
  {
    packageId: "profile-trash",
    kind: "profile",
    state: "trashed",
    versionName: "合成简历",
    archiveId: "episode-profile",
    archivedAt: "2099-01-01T00:00:00Z",
    purgeAt: "2099-01-04T00:00:00Z",
    counts,
  },
  {
    packageId: "old-trash",
    kind: "legacy_unassigned",
    state: "trashed",
    versionName: "合成旧数据",
    archiveId: "episode-old",
    archivedAt: "2099-01-01T00:00:00Z",
    purgeAt: "2099-01-04T00:00:00Z",
    counts,
  },
];
const preview = {
  workspaceRevision: 10,
  planHash: "trash-plan",
  packageCount: 3,
  totals: counts,
  candidates: rows.map((r) => ({
    packageId: r.packageId,
    archiveId: r.archiveId,
    purgeAt: r.purgeAt,
    counts,
  })),
};

function controlledClock(t: TestContext, initial: number) {
  let now = initial;
  let next = 0;
  const intervals = new Map<number, () => void>();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback: () => void) => {
    const id = ++next;
    intervals.set(id, callback);
    return id;
  });
  t.mock.method(globalThis, "clearInterval", (id: number) =>
    intervals.delete(id),
  );
  return {
    async advance(ms: number) {
      await act(async () => {
        now += ms;
        for (const callback of [...intervals.values()]) callback();
      });
    },
  };
}

test("unexpired trash explains its owned version before technical details and removes all content at expiry", async (t) => {
  const start = Date.parse("2099-01-01T00:00:00Z");
  const clock = controlledClock(t, start);
  const row = {
    ...rows[0],
    enabled: false,
    purgeAt: new Date(start + 2000).toISOString(),
  };
  const f = await renderApp(t, {
    route: "#/trash",
    apiHandler: (path) =>
      path === "/trash"
        ? { items: [row] }
        : path === "/trash/target-trash"
          ? {
              package: row,
              counts,
              targets: [
                {
                  versionName: row.versionName,
                  revisionId: "target-version-technical",
                  enabled: true,
                  roles: ["消防工程师"],
                  cities: ["深圳"],
                  cityMode: "selected",
                  profileSnapshot: {
                    revisionId: "copy-technical",
                    text: "PRIVATE_BODY_SENTINEL",
                    profile: {
                      name: "合成回收副本人",
                      degree: "本科",
                      major: "安全工程",
                    },
                  },
                },
              ],
              profiles: [],
              snapshots: [{ message: "PRIVATE_DIAGNOSTIC_SENTINEL" }],
              privatePayload: "PRIVATE_DIAGNOSTIC_SENTINEL",
            }
          : undefined,
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "查看内容合成消防方向" }),
  );
  const summary = await f.screen.findByRole("region", { name: "版本内容摘要" });
  assert.ok(within(summary).getByText("合成消防方向"));
  assert.ok(within(summary).getByText("目标版本"));
  assert.ok(within(summary).getByText("消防工程师"));
  assert.ok(within(summary).getByText("深圳"));
  assert.ok(within(summary).getByText("合成回收副本人"));
  assert.ok(within(summary).getByText("已停用"));
  assert.equal(f.screen.queryByText(/"profileSnapshot"/), null);
  assert.doesNotMatch(
    summary.textContent ?? "",
    /target-trash|target-version-technical|PRIVATE_DIAGNOSTIC/,
  );
  await f.user.click(within(summary).getByRole("button", { name: "简历正文" }));
  assert.ok(f.screen.getByText("PRIVATE_BODY_SENTINEL"));
  await f.user.click(within(summary).getByRole("button", { name: "技术详情" }));
  assert.ok(within(summary).getByText("target-trash"));
  assert.doesNotMatch(document.body.textContent ?? "", /PRIVATE_DIAGNOSTIC/);
  const detailRead = f.apiCalls.find((c) => c.path === "/trash/target-trash")!;
  assert.equal(detailRead.scope, undefined);
  await clock.advance(2000);
  assert.equal(f.screen.queryByRole("region", { name: "版本内容摘要" }), null);
  assert.equal(f.screen.queryByText("PRIVATE_BODY_SENTINEL"), null);
  assert.equal(
    f.screen.queryByRole("button", { name: "恢复合成消防方向" }),
    null,
  );
  assert.equal(detailRead.options.signal?.aborted, true);
  assert.equal(
    f.apiCalls.filter(
      (c) => c.path === "/trash/purge" || c.path === "/trash/restore",
    ).length,
    0,
  );
});

test("purge confirmation uses semantic counts and preserves zero and unreported values", async (t) => {
  const f = await renderApp(t, {
    route: "#/trash",
    apiHandler: (path) =>
      path === "/trash"
        ? { items: rows }
        : path === "/trash/preview"
          ? {
              ...preview,
              totals: { jobs: 2, applications: 0, observations: 3 },
            }
          : undefined,
  });
  await f.user.click(
    await f.screen.findByRole("button", { name: "清空整个回收站" }),
  );
  const totals = await f.screen.findByRole("region", {
    name: "永久删除内容计数",
  });
  assert.equal(
    within(totals).getByText("岗位").nextElementSibling?.textContent,
    "2",
  );
  assert.equal(
    within(totals).getByText("投递记录").nextElementSibling?.textContent,
    "0",
  );
  assert.equal(
    within(totals).getByText("来源记录").nextElementSibling?.textContent,
    "3",
  );
  assert.equal(
    within(totals).getByText("文件").nextElementSibling?.textContent,
    "未统计",
  );
  assert.equal(f.screen.queryByText("trash-plan"), null);
  await f.user.click(f.screen.getByRole("button", { name: "取消" }));
  assert.equal(f.apiCalls.filter((c) => c.path === "/trash/purge").length, 0);
});

test("empty confirmation covers all trash despite profile filter and cancel never purges", async (t) => {
  const f = await renderApp(t, {
    route: "#/trash",
    apiHandler: (path) =>
      path === "/trash"
        ? { items: rows }
        : path === "/trash/preview"
          ? preview
          : undefined,
  });
  await f.user.click(f.screen.getByRole("tab", { name: "简历版本" }));
  await f.user.click(f.screen.getByRole("button", { name: "清空整个回收站" }));
  const confirmation = await f.screen.findByRole("alertdialog");
  assert.match(confirmation.textContent || "", /3 个版本/);
  assert.match(confirmation.textContent || "", /岗位.*2/);
  assert.deepEqual(f.apiCalls.find((c) => c.path === "/trash/preview")?.body, {
    emptyAll: true,
  });
  await f.user.click(f.screen.getByRole("button", { name: "取消" }));
  assert.equal(f.apiCalls.filter((c) => c.path === "/trash/purge").length, 0);
});

test("expired and pending rows cannot reveal private body or restore", async (t) => {
  const f = await renderApp(t, {
    route: "#/trash",
    apiHandler: (path) =>
      path === "/trash"
        ? {
            items: [
              {
                ...rows[0],
                archivedAt: "2020-01-01T00:00:00Z",
                purgeAt: "2020-01-04T00:00:00Z",
                body: "PRIVATE_BODY_SENTINEL",
              },
              {
                packageId: "pending-trash",
                kind: "profile",
                state: "purge_pending",
                operationId: "purge-anonymous-1",
                counts,
                phase: "files",
                code: "purge_file_failed",
                versionName: "PRIVATE_NAME_SENTINEL",
                body: "PRIVATE_BODY_SENTINEL",
              },
            ],
          }
        : path.startsWith("/trash/operations/")
          ? {
              operationId: "purge-anonymous-1",
              phase: "files",
              counts,
              code: "purge_file_failed",
            }
          : undefined,
  });
  assert.ok(await f.screen.findByText("已到期，等待清理"));
  assert.equal(f.screen.queryByRole("button", { name: /^恢复/ }), null);
  assert.equal(f.screen.queryByRole("button", { name: /^查看内容/ }), null);
  assert.doesNotMatch(document.body.textContent || "", /PRIVATE_/);
  assert.equal(f.screen.queryByText(/purge-anonymous-1/), null);
  const operation = f.screen.getByRole("region", { name: "清理操作摘要" });
  assert.ok(within(operation).getByText("清理失败，可重试"));
  await f.user.click(
    within(operation).getByRole("button", { name: "技术详情" }),
  );
  assert.ok(within(operation).getByText("purge-anonymous-1"));
});

test("stale preview blocks repeat purge and asks for a new preview", async (t) => {
  let attempts = 0;
  const f = await renderApp(t, {
    route: "#/trash",
    apiHandler: (path) => {
      if (path === "/trash") return { items: rows };
      if (path === "/trash/preview") return preview;
      if (path === "/trash/purge") {
        attempts++;
        throw Object.assign(new Error("回收站内容已变化"), {
          code: "trash_preview_stale",
          status: 409,
        });
      }
    },
  });
  await f.user.click(f.screen.getByRole("button", { name: "清空整个回收站" }));
  await f.user.click(
    await f.screen.findByRole("button", { name: "确认永久删除" }),
  );
  assert.ok(await f.screen.findByText(/重新预览/));
  assert.equal(attempts, 1);
  assert.equal(f.screen.queryByText("永久删除完成"), null);
});

test("purge result distinguishes completed pending and failed without claiming all success", async (t) => {
  const f = await renderApp(t, {
    route: "#/trash",
    apiHandler: (path) =>
      path === "/trash"
        ? { items: rows }
        : path === "/trash/preview"
          ? preview
          : path === "/trash/purge"
            ? {
                completed: ["target-trash"],
                pending: ["profile-trash"],
                failed: [
                  { operationId: "purge-failed-1", code: "purge_file_failed" },
                ],
              }
            : undefined,
  });
  await f.user.click(f.screen.getByRole("button", { name: "清空整个回收站" }));
  await f.user.click(
    await f.screen.findByRole("button", { name: "确认永久删除" }),
  );
  assert.ok(await f.screen.findByText(/已完成 1.*处理中 1.*失败 1/));
  assert.equal(f.screen.queryByText("永久删除完成"), null);
  assert.deepEqual(
    f.apiCalls.find((c) => c.path === "/trash/purge")?.body,
    preview,
  );
});

test("unexpired trash restores the exact archive episode once after server commits", async (t) => {
  let release!: (result: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await renderApp(t, {
    route: "#/trash",
    apiHandler: (path) =>
      path === "/trash"
        ? { items: [rows[0]] }
        : path === "/trash/restore"
          ? pending
          : undefined,
  });
  const restore = await f.screen.findByRole("button", {
    name: "恢复合成消防方向",
  });
  await f.user.click(restore);
  await f.user.click(restore);
  assert.equal(f.screen.queryByText("已恢复整个版本"), null);
  assert.equal(f.apiCalls.filter((c) => c.path === "/trash/restore").length, 1);
  assert.deepEqual(f.apiCalls.find((c) => c.path === "/trash/restore")?.body, {
    packageId: "target-trash",
    archiveId: "episode-target",
  });
  release({ ...rows[0], state: "active" });
  assert.ok((await f.screen.findAllByText("已恢复整个版本")).length);
});

test("pending completion refreshes trash and visible versions", async (t) => {
  let reads = 0;
  const f = await renderApp(t, {
    route: "#/trash",
    apiHandler: (path) => {
      if (path === "/trash")
        return {
          items:
            ++reads === 1
              ? [
                  {
                    packageId: "pending",
                    kind: "target",
                    state: "purge_pending",
                    operationId: "purge-poll",
                    counts,
                    phase: "files",
                  },
                ]
              : [],
        };
      if (path === "/trash/operations/purge-poll")
        return { operationId: "purge-poll", counts, phase: "completed" };
    },
  });
  const initialTargetReads = f.apiCalls.filter(
    (c) => c.path === "/targets",
  ).length;
  assert.ok(await f.screen.findByText("回收站为空", {}, { timeout: 7000 }));
  assert.equal(
    f.apiCalls.filter((c) => c.path === "/trash/operations/purge-poll").length,
    1,
  );
  assert.ok(
    f.apiCalls.filter((c) => c.path === "/targets").length > initialTargetReads,
  );
});

test("pending polling aborts on page unmount and ignores late completion", async (t) => {
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: (result: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = await renderApp(t, {
    route: "#/trash",
    apiHandler: (path) => {
      if (path === "/trash")
        return {
          items: [
            {
              packageId: "pending",
              kind: "profile",
              state: "purge_pending",
              operationId: "purge-stop",
              counts,
              phase: "files",
            },
          ],
        };
      if (path === "/trash/operations/purge-stop") {
        reached();
        return pending;
      }
    },
  });
  await act(async () => {
    await started;
  });
  f.unmount();
  const call = f.apiCalls.find(
    (c) => c.path === "/trash/operations/purge-stop",
  );
  assert.equal(call?.options.signal?.aborted, true);
  const before = f.apiCalls.length;
  await act(async () => {
    release({ operationId: "purge-stop", counts, phase: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(f.apiCalls.length, before);
});
