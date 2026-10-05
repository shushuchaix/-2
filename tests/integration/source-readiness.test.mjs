import test from "node:test";
import assert from "node:assert/strict";
import { countReadyProviders } from "../../tools/probe-sources-v2.mjs";
import { createImportService } from "../../src/application/import-service.mjs";
import { openWorkspaceRepository } from "../../src/infrastructure/storage/repository.mjs";
import { createJobService } from "../../src/application/job-service.mjs";
import { createTempDir } from "../helpers/fixtures.mjs";
test("readiness counts distinct automated providers with body evidence only", () => {
  const result = (id, category = "employer") => ({
    sourceId: id,
    category,
    status: "ready",
    evidence: [
      {
        sourceRecordId: "1",
        title: "工程岗位",
        url: "https://example.com/job",
        hasRequirements: true,
      },
    ],
  });
  assert.equal(
    countReadyProviders(
      [
        "ncss",
        "university-91job",
        "official-announcements",
        "tencent",
        "smartrecruiters",
        "greenhouse",
      ].map((id) => result(id)),
    ),
    6,
  );
  assert.equal(
    countReadyProviders([
      result("university-91job"),
      result("university-91job"),
    ]),
    1,
  );
  assert.equal(
    countReadyProviders([
      { ...result("greenhouse"), evidence: [{ url: "https://example.com" }] },
      result("searchapi"),
      result("wechat"),
    ]),
    0,
  );
});
test("imports retain social provenance without fetching prohibited platform bodies", async (t) => {
  const repository = await openWorkspaceRepository({
    dataDir: await createTempDir(t),
  });
  const jobs = createJobService({ repository });
  let calls = 0;
  const service = createImportService({
    repository,
    jobService: jobs,
    request: async () => {
      calls++;
      throw Error("Unexpected outgoing request");
    },
  });
  await assert.rejects(
    service.import({ url: "http://127.0.0.1/x", text: "招聘" }),
    /private|address/i,
  );
  const result = await service.import({
    url: "https://mp.weixin.qq.com/s/abc",
    text: "校园招聘公告\n合成公司招聘工程师，本科以上。",
    account: "合成公司招聘",
    note: "待核实账号身份",
  });
  assert.equal(calls, 0);
  assert.equal(result.jobIds.length, 1);
  const { job, application } = await jobs.getJob(result.jobIds[0]);
  assert.equal(job.canonical.publishedAt, null);
  assert.equal(job.kind, "recruitment_notice");
  assert.equal(job.canonical.platform, "wechat");
  assert.equal(job.canonical.evidenceLevel, "user_provided");
  assert.equal(application.note, "待核实账号身份");
  const textOnly = await service.import({
    text: "文本招聘公告\n软件工程岗位，本科以上，须核实原始招聘入口。",
  });
  assert.equal((await jobs.getJob(textOnly.jobIds[0])).job.canonical.url, null);
});
