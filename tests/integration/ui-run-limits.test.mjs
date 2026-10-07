import test from "node:test";
import assert from "node:assert/strict";
import { uiFixture } from "../helpers/ui-fixture.mjs";
import {
  runProgress,
  runOutcomeText,
} from "../../public/js/components/run-progress.js";

const run = (patch = {}) => ({
  status: "partial",
  stage: "finished",
  degraded: true,
  counts: {
    raw: 593,
    normalized: 282,
    deduplicated: 282,
    notices: 42,
    eligible: 0,
    qualificationUnknown: 240,
    qualificationFailed: 42,
    shortlisted: 197,
    aiSuccess: 148,
    fallback: 134,
  },
  usage: {
    sources: { requests: 72, maxRequests: 120, details: 20, maxDetails: 20 },
    model: { requests: 20, maxRequests: 20 },
  },
  coverage: [],
  issues: [],
  ...patch,
});
function render(value) {
  const { document } = uiFixture(() => {});
  return runProgress({ document, run: value });
}

test("page limits describe collected scope without claiming planned sources failed", () => {
  const text = runOutcomeText(
    run({
      coverage: [
        {
          status: "complete",
          truncated: true,
          truncationReason: "page_limit",
          pages: 2,
        },
      ],
    }),
  );
  assert.match(text, /分页/);
  assert.doesNotMatch(text, /未覆盖全部来源|预算.*耗尽/);
});

test("listing-only sources explain restricted history without a fictitious exhausted budget", () => {
  const text = runOutcomeText(
    run({
      coverage: [
        {
          status: "complete",
          truncated: true,
          truncationReason: "listing_only",
          pages: 1,
        },
      ],
    }),
  );
  assert.match(text, /列表|首页/);
  assert.doesNotMatch(text, /达到采集上限|预算.*耗尽/);
});

test("unknown qualifications and recommendation counts remain distinct", () => {
  const node = render(run());
  assert.match(node.textContent, /已确认资格通过\s*0/);
  assert.match(node.textContent, /资格待核实\s*240/);
  assert.match(node.textContent, /资格不符合\s*42/);
  assert.doesNotMatch(node.textContent, /资格[^\n]*→[^\n]*模型/);
  assert.match(node.textContent, /详情\s*20\s*\/\s*20/);
});

test("known budget fallback gives an affected count instead of a settings failure hint", () => {
  const node = render(
    run({
      issues: [
        {
          code: "model_budget_exhausted",
          affectedCount: 118,
          diagnosticId: "d-budget",
          message: "剩余岗位保留规则评价。",
        },
      ],
    }),
  );
  assert.match(node.textContent, /118/);
  assert.doesNotMatch(node.textContent, /检查模型设置|规则模式重试/);
});

test("source request budget exhaustion does not advise repairing a healthy network", () => {
  const node = render(
    run({
      coverage: [
        {
          status: "failed",
          truncated: true,
          truncationReason: "request_budget",
        },
      ],
      issues: [
        { code: "source_budget_exhausted", sourceId: "ncss", siteId: "ncss" },
      ],
    }),
  );
  assert.match(node.textContent, /预算/);
  assert.match(node.textContent, /采集请求预算已用完/);
  assert.doesNotMatch(node.textContent, /检查网络|可用状态/);
});

test("issues sharing one diagnostic number are grouped while distinct failures stay visible", () => {
  const node = render(
    run({
      issues: [
        ...Array.from({ length: 5 }, (_, index) => ({
          code: "invalid_model_result",
          diagnosticId: "d-batch-one",
          jobId: "j-" + index,
        })),
        {
          code: "invalid_model_result",
          diagnosticId: "d-batch-two",
          jobId: "j-other",
        },
      ],
    }),
  );
  assert.equal(node.textContent.split("d-batch-one").length - 1, 1);
  assert.equal(node.textContent.split("d-batch-two").length - 1, 1);
  assert.match(node.textContent, /影响.*5\s*条/);
});
