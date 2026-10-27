import test from "node:test";
import assert from "node:assert/strict";
import { packageBusinessFixture } from "../helpers/package-business-fixture.mjs";
import { job, profile, target } from "../helpers/fixtures.mjs";
import { createEvaluationService } from "../../src/application/evaluation-service.mjs";

for (const [expected, skills, roles] of [
  ["high", ["Java"], ["Java开发"]],
  ["consider", ["Python"], ["Java开发"]],
  ["low", ["Python"], ["财务"]],
]) {
  test(`rules-only schema3 service and job query produce ${expected} with verified evidence`, async (t) => {
    const f = await packageBusinessFixture(t);
    const p = await f.workspaceService.saveProfile({
      profile: profile({ skills }),
      text: "合成简历，仅用于离线回归。软件工程本科，2027届毕业，具备软件开发、接口维护和项目测试实践，求职意向为Java开发。",
      versionName: "合成简历 " + expected,
      submissionId: "rules-profile-" + expected,
    });
    const tar = await f.workspaceService.saveTarget({
      ...target(),
      targetId: undefined,
      profileRevisionId: p.revisionId,
      roles,
      versionName: "合成目标 " + expected,
      submissionId: "rules-target-" + expected,
    });
    const scope = {
      packageId: tar.packageId,
      targetRevisionId: tar.revisionId,
    };
    const [id] = await f.ingest(scope, [
      job({
        detailStatus: "complete",
        bodyStatus: "complete",
        description:
          "负责Java开发、接口维护和应用程序测试，要求本科学历，面向2027届毕业生，工作地点北京。",
        deadlineAt: "2027-01-01T00:00:00.000Z",
        applyUrl: "https://jobs.example.com/apply",
        applicationVerification: {
          status: 200,
          formVerified: true,
          checkedAt: new Date(f.clock.now()).toISOString(),
        },
      }),
    ]);
    let modelCalls = 0;
    const service = createEvaluationService({
      repository: f.repository,
      operationGate: f.operationGate,
      modelFactory: () => {
        modelCalls++;
        throw Error("rules-only evaluation must not create a model");
      },
    });
    const result = await service.evaluate({
      scope,
      jobIds: [id],
      profileRevisionId: tar.profileRevisionId,
      targetRevisionId: tar.revisionId,
      mode: "rules",
    });
    const e = result.evaluations[0];
    assert.equal(e.status, "rules");
    assert.equal(e.qualification.status, "pass");
    assert.equal(e.recommendation, expected);
    assert.equal(e.recommended, true);
    assert.equal(modelCalls, 0);
    const rows = await f.jobs.queryJobs(scope);
    assert.equal(rows.items[0].evaluation.recommendation, expected);
    assert.equal(rows.items[0].evaluation.recommended, true);
  });
}
