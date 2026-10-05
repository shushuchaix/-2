import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export const AT = "2026-10-05T00:00:00.000Z";
export const job = (overrides = {}) => ({
  sourceId: "synthetic",
  siteId: "synthetic-1",
  sourceRecordId: "1",
  identityScope: "synthetic-1",
  kind: "job",
  title: "Java开发工程师",
  company: "合成公司",
  cities: ["北京"],
  jobType: "campus",
  graduationYear: 2027,
  level: null,
  url: "https://jobs.example.com/1",
  applyUrl: null,
  description: "负责Java开发，要求本科，2027届毕业。",
  degree: "本科",
  experience: null,
  requiredCertificates: [],
  deadlineAt: null,
  publishedAt: AT,
  salary: null,
  evidence: [],
  parserVersion: "fixture-1",
  ...overrides,
});
export const profile = (overrides = {}) => ({
  education: "本科",
  major: "软件工程",
  graduationYear: 2027,
  skills: ["Java"],
  certificates: [],
  projects: [],
  internships: [],
  cities: ["北京"],
  explicitFacts: {},
  ...overrides,
});
export const target = (overrides = {}) => ({
  targetId: "t1",
  revision: 1,
  revisionId: "t1@1",
  profileRevisionId: "p1@1",
  enabled: true,
  roles: ["Java开发"],
  cityMode: "selected",
  cities: ["北京"],
  jobTypes: ["campus", "internship"],
  degreePolicy: "eligibility",
  sourceIds: ["synthetic"],
  siteIds: [],
  coverageMode: "standard",
  budgets: {},
  createdAt: AT,
  ...overrides,
});
export async function createTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rjr-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
