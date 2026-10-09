import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCollectionRuntime } from "../src/infrastructure/collection/runtime.mjs";
export { verifyCollectionRuntime };
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await verifyCollectionRuntime({
    root: process.argv[2] || path.resolve(".cache/collection-runtime-dev"),
  });
  console.log(
    JSON.stringify({
      available: result.available,
      capabilities: result.capabilities,
      issues: result.issues,
    }),
  );
  process.exitCode = result.available ? 0 : 1;
}
