import { discoverSourceCandidates } from "../src/sources/discovery.mjs";
import { createRequestClient } from "../src/infrastructure/http/client.mjs";
import { createSourceBudget } from "../src/infrastructure/http/budget.mjs";
import fs from "node:fs/promises";
import path from "node:path";
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const seed = arg("--seed");
if (!seed)
  throw Error("Use --seed <public official URL> [--output <workspace JSON>].");
const budget = createSourceBudget({ maxRequests: 100, maxDetails: 0 }),
  request = createRequestClient({ budget });
// Discovery proposes candidates only. It never changes the enabled catalog.
const archiveLookup = process.argv.includes("--archive")
  ? async ({ hostname, signal, limit }) => {
      const indexes = await request(
          "https://index.commoncrawl.org/collinfo.json",
          { signal, maxRetries: 0, kind: "list" },
        ),
        index = JSON.parse(indexes.text).find((i) =>
          /^CC-MAIN-\d{4}-\d{2}$/.test(i.id),
        );
      if (!index) return [];
      const endpoint = new URL(
        "https://index.commoncrawl.org/" + index.id + "-index",
      );
      endpoint.searchParams.set("url", hostname + "/*");
      endpoint.searchParams.set("output", "json");
      endpoint.searchParams.set("filter", "status:200");
      endpoint.searchParams.set("collapse", "urlkey");
      endpoint.searchParams.set("pageSize", String(limit));
      const response = await request(endpoint.href, {
        signal,
        maxRetries: 0,
        kind: "list",
      });
      return response.status === 200
        ? response.text
            .split("\n")
            .filter(Boolean)
            .slice(0, limit)
            .flatMap((line) => {
              try {
                return [JSON.parse(line).url];
              } catch {
                return [];
              }
            })
        : [];
    }
  : undefined;
const candidates = await discoverSourceCandidates({
  seed,
  request,
  maxDepth: 2,
  maxUrls: 100,
  archiveLookup,
});
if (arg("--output")) {
  const destination = path.resolve(arg("--output")),
    relative = path.relative(process.cwd(), destination);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw Error("Output must stay in workspace");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(
    destination,
    JSON.stringify({ candidates, budget: budget.snapshot() }, null, 2) + "\n",
  );
}
console.log(
  JSON.stringify({
    candidateCount: candidates.length,
    budget: budget.snapshot(),
  }),
);
