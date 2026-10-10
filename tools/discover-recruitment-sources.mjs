import {
  discoverSourceCandidates,
  validatePublicSeeds,
} from "../src/sources/discovery.mjs";
import { createRequestClient } from "../src/infrastructure/http/client.mjs";
import { createSourceBudget } from "../src/infrastructure/http/budget.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Caller supplies the shared request/ledger. Imports never enable or probe candidates. */
export async function importPublicSeeds({
  seeds,
  request,
  signal,
  archiveLookup,
}) {
  const checked = validatePublicSeeds(seeds),
    candidates = new Map();
  for (const seed of checked) {
    signal?.throwIfAborted();
    const proposed = await discoverSourceCandidates({
      seed: { url: seed.homepage, name: seed.institutionName },
      request,
      signal,
      maxDepth: 2,
      maxUrls: 100,
      archiveLookup,
    });
    for (const candidate of proposed)
      if (!candidates.has(candidate.siteId))
        candidates.set(candidate.siteId, {
          ...candidate,
          institutionName: seed.institutionName,
          channel: seed.channel,
          seedEvidenceUrl: seed.evidenceUrl,
        });
  }
  return { seeds: checked.length, candidates: [...candidates.values()] };
}
async function main() {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const seed = arg("--seed"),
    seedsFile = arg("--public-seeds");
  if ((!seed && !seedsFile) || (seed && seedsFile))
    throw Error(
      "Use --seed <public official URL> or --public-seeds <JSON> [--output <workspace JSON>].",
    );
  const seeds = seedsFile
    ? validatePublicSeeds(JSON.parse(await fs.readFile(seedsFile, "utf8")))
    : null;
  let destination;
  if (arg("--output")) {
    destination = path.resolve(arg("--output"));
    const relative = path.relative(process.cwd(), destination);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("Output must stay in workspace");
  }
  const budget = createSourceBudget({ maxRequests: 100, maxDetails: 0 }),
    request = createRequestClient({ budget });
  const archiveLookup = process.argv.includes("--archive")
    ? async ({ hostname, signal, limit }) => {
        const indexes = await request(
          "https://index.commoncrawl.org/collinfo.json",
          { signal, maxRetries: 0, kind: "list" },
        );
        if (indexes.status !== 200) return [];
        const index = JSON.parse(indexes.text).find((i) =>
          /^CC-MAIN-\d{4}-\d{2}$/.test(i.id),
        );
        if (!index) return [];
        const endpoint = new URL(
          "https://index.commoncrawl.org/" + index.id + "-index",
        );
        for (const [key, value] of Object.entries({
          url: hostname + "/*",
          output: "json",
          filter: "status:200",
          collapse: "urlkey",
          pageSize: String(limit),
        }))
          endpoint.searchParams.set(key, value);
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
  const result = seeds
    ? await importPublicSeeds({ seeds, request, archiveLookup })
    : {
        seeds: 1,
        candidates: await discoverSourceCandidates({
          seed,
          request,
          maxDepth: 2,
          maxUrls: 100,
          archiveLookup,
        }),
      };
  if (destination) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(
      destination,
      JSON.stringify({ ...result, budget: budget.snapshot() }, null, 2) + "\n",
    );
  }
  console.log(
    JSON.stringify({
      seedCount: result.seeds,
      candidateCount: result.candidates.length,
      budget: budget.snapshot(),
    }),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
