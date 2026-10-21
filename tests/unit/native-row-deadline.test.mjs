import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareApplicationCheck,
  prepareRecruitmentRecord,
} from "../../src/domain/recruitment-evidence.mjs";
import { job } from "../helpers/fixtures.mjs";

const now = Date.parse("2026-10-12T00:00:00Z");
const nativeDate = (extra = {}) => ({
  field: "deadlineDate",
  value: "2026-10-15",
  status: "verified",
  sourceId: "official-announcements",
  sourceUrl: "https://airport.example.org/talent/index.html",
  sourceKind: "visible_native_deadline_date",
  sourceExcerpt: "招聘截止日期：2026-10-15",
  location: {
    selector: ".talent_list .inside_item .title .time",
    labelSelector: ".talent_nav .time",
    nativeIdSelector: ".talent_list .inside_item .talent_bot a.download[href]",
  },
  appliesTo: { jobRowId: "37" },
  ...extra,
});
const notice = (description, extra = {}) =>
  job({
    sourceId: "official-announcements",
    siteId: "synthetic-airport",
    identityScope: "synthetic-airport",
    sourceRecordId: "37",
    sourceRecordIdKind: "authority",
    title: "合成机场消防管理",
    url: "https://airport.example.org/talent/detail/id/37.html",
    applyUrl: "https://airport.example.org/talent/application/id/37.html",
    description,
    detailStatus: "complete",
    bodyStatus: "complete",
    sourceEvidence: [nativeDate()],
    ...extra,
  });

for (const [label, body, expected] of [
  [
    "a colon clock",
    "报名截止时间：10月15日12:00。",
    "2026-10-15T04:00:00.000Z",
  ],
  [
    "a precise noon clock",
    "报名截止时间：10月15日中午12点。",
    "2026-10-15T04:00:00.000Z",
  ],
  [
    "a matching day without clock",
    "报名截止时间：10月15日。",
    "2026-10-15T15:59:59.999Z",
  ],
  [
    "an independently explicit full cutoff column",
    "负责机场消防安全管理。",
    "2026-10-15T15:59:59.999Z",
  ],
  [
    "a midnight clock",
    "报名截止时间：10月15日24:00。",
    "2026-10-15T16:00:00.000Z",
  ],
  [
    "a precise partial clock alongside a complete day-only date",
    "报名截止时间：2026年10月15日。报名截止时间：10月15日12:00。",
    "2026-10-15T04:00:00.000Z",
  ],
  [
    "matching complete and partial clocks",
    "报名截止时间：10月15日12:00。报名截止时间：2026年10月15日12:00。",
    "2026-10-15T04:00:00.000Z",
  ],
]) {
  test(`the same authority row's full cutoff date supports ${label}`, () => {
    const record = notice(body, { publishedAt: "2020-01-01T00:00:00Z" });
    const before = structuredClone(record);
    const prepared = prepareRecruitmentRecord(record, now);
    assert.equal(prepared.deadlineAt, expected);
    assert.equal(prepared.recruitmentEvidence.openingStatus, "open");
    assert.equal(prepared.recruitmentEvidence.applicationStatus, "unknown");
    assert.deepEqual(record, before);
  });
}

test("a matched cutoff hour expires before application HTTP without assuming a calendar year", () => {
  const record = notice("报名截止时间：10月15日12:00。");
  const afterNoon = Date.parse("2026-10-15T04:00:00.001Z");
  const prepared = prepareRecruitmentRecord(record, afterNoon);
  assert.equal(prepared.deadlineAt, "2026-10-15T04:00:00.000Z");
  assert.equal(prepared.recruitmentEvidence.openingStatus, "expired");
  assert.equal(prepareApplicationCheck(record, afterNoon).shouldRequest, false);
});

for (const [label, body, expected] of [
  [
    "an early local clock",
    "报名截止时间：10月15日07:00。",
    "2026-10-14T23:00:00.000Z",
  ],
  [
    "the end-of-day midnight clock",
    "报名截止时间：10月15日24:00。",
    "2026-10-15T16:00:00.000Z",
  ],
]) {
  test(`repreparing ${label} cannot create a UTC calendar conflict`, () => {
    const first = prepareRecruitmentRecord(notice(body), now);
    const again = prepareRecruitmentRecord(first, now);
    assert.equal(first.deadlineAt, expected);
    assert.equal(again.deadlineAt, expected);
    assert.equal(again.recruitmentEvidence.openingStatus, "open");
    assert.deepEqual(
      again.evidenceConflicts || [],
      first.evidenceConflicts || [],
    );
    assert.equal(prepareApplicationCheck(first, now).shouldRequest, true);
  });
}

for (const [label, evidence, recordExtra = {}] of [
  ["missing cutoff provenance", [], {}],
  ["unknown cutoff provenance", [nativeDate({ status: "unknown" })]],
  ["a generic date field", [nativeDate({ field: "publishedAt" })]],
  [
    "a different provenance kind",
    [nativeDate({ sourceKind: "visible_list_date" })],
  ],
  ["a different native job", [nativeDate({ appliesTo: { jobRowId: "58" } })]],
  ["missing native job binding", [nativeDate({ appliesTo: {} })]],
  [
    "an unverified authority identifier",
    [nativeDate()],
    { sourceRecordIdKind: "hint" },
  ],
  ["a missing native identifier", [nativeDate()], { sourceRecordId: null }],
  [
    "a different identity scope",
    [nativeDate()],
    { identityScope: "other-airport" },
  ],
  ["a foreign source", [nativeDate({ sourceId: "other-provider" })]],
  [
    "a foreign origin",
    [nativeDate({ sourceUrl: "https://other.example.org/talent/" })],
  ],
  [
    "a publication date label",
    [nativeDate({ sourceExcerpt: "发布日期：2026-10-15" })],
  ],
  [
    "missing row selector",
    [
      nativeDate({
        location: { labelSelector: ".cutoff", nativeIdSelector: ".native-id" },
      }),
    ],
  ],
  [
    "missing label selector",
    [
      nativeDate({
        location: { selector: ".row .cutoff", nativeIdSelector: ".native-id" },
      }),
    ],
  ],
  [
    "missing native ID selector",
    [
      nativeDate({
        location: { selector: ".row .cutoff", labelSelector: ".cutoff" },
      }),
    ],
  ],
  ["low confidence cutoff", [nativeDate({ confidence: 84 })]],
  ["NaN confidence", [nativeDate({ confidence: NaN })]],
  ["infinite confidence", [nativeDate({ confidence: Infinity })]],
  ["a string confidence", [nativeDate({ confidence: "100" })]],
  ["an ambiguous row", [nativeDate()], { rowAmbiguous: true }],
  ["an ambiguous fact", [nativeDate({ ambiguous: true })]],
  [
    "an impossible full cutoff date",
    [
      nativeDate({
        value: "2026-02-30",
        sourceExcerpt: "招聘截止日期：2026-02-30",
      }),
    ],
  ],
]) {
  test(`${label} cannot supply the missing year from publication or the current year`, () => {
    const prepared = prepareRecruitmentRecord(
      notice("报名截止时间：10月15日12:00。", {
        sourceEvidence: evidence,
        publishedAt: "2026-10-10T00:00:00Z",
        ...recordExtra,
      }),
      now,
    );
    assert.equal(prepared.deadlineAt, null);
    assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  });
}

for (const [label, body] of [
  ["a different month", "报名截止时间：11月15日12:00。"],
  ["a different day", "报名截止时间：10月16日12:00。"],
  [
    "conflicting body cutoff hours",
    "报名截止时间：10月15日12:00。报名截止时间：10月15日17:00。",
  ],
  ["a conflicting complete body date", "报名截止时间：2026年10月16日12:00。"],
  [
    "conflicting complete and partial clocks",
    "报名截止时间：10月15日12:00。报名截止时间：2026年10月15日17:00。",
  ],
]) {
  test(`${label} remains an explicit conflict with the native cutoff column`, () => {
    const prepared = prepareRecruitmentRecord(notice(body), now);
    assert.equal(prepared.deadlineAt, null);
    assert.ok(
      prepared.evidenceConflicts?.some((c) => c.field === "deadlineAt"),
    );
    assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
    assert.equal(prepareApplicationCheck(prepared, now).shouldRequest, false);
  });
}

test("two incompatible verified full cutoff dates remain unknown", () => {
  const prepared = prepareRecruitmentRecord(
    notice("报名截止时间：10月15日12:00。", {
      sourceEvidence: [
        nativeDate(),
        nativeDate({
          value: "2026-10-16",
          sourceExcerpt: "招聘截止日期：2026-10-16",
        }),
      ],
    }),
    now,
  );
  assert.equal(prepared.deadlineAt, null);
  assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  assert.ok(prepared.evidenceConflicts?.some((c) => c.field === "deadlineAt"));
});

test("preparing an existing native deadline conflict does not duplicate its evidence", () => {
  const first = prepareRecruitmentRecord(
    notice("报名截止时间：10月16日12:00。"),
    now,
  );
  const again = prepareRecruitmentRecord(first, now);
  assert.deepEqual(again.evidenceConflicts, first.evidenceConflicts);
  assert.equal(again.deadlineAt, null);
  assert.equal(again.recruitmentEvidence.openingStatus, "unknown");
});

test("an invalid native-row clock cannot retain a previous valid canonical deadline", () => {
  const prepared = prepareRecruitmentRecord(
    notice("报名截止时间：10月15日25:00。", {
      deadlineAt: "2026-10-15T04:00:00.000Z",
    }),
    now,
  );
  assert.equal(prepared.deadlineAt, null);
  assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
});

for (const [label, body] of [
  ["an invalid hour", "报名截止时间：10月15日25:00。"],
  ["an invalid minute", "报名截止时间：10月15日12:60。"],
  ["nonzero midnight minutes", "报名截止时间：10月15日24:01。"],
  ["an unsupported noon interpretation", "报名截止时间：10月15日中午1点。"],
  ["an ambiguous clock", "报名截止时间：10月15日下午1点左右。"],
  ["an approximate clock", "报名截止时间：10月15日12:00左右。"],
  ["a clock range", "报名截止时间：10月15日12:00至17:00。"],
  ["a clock start", "报名截止时间：10月15日12:00以后。"],
]) {
  test(`${label} does not fall back to an end-of-day cutoff`, () => {
    const prepared = prepareRecruitmentRecord(notice(body), now);
    assert.equal(prepared.deadlineAt, null);
    assert.equal(prepared.recruitmentEvidence.openingStatus, "unknown");
  });
}
