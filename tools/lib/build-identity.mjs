import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Content identity of the shipped first-party code and generated UI. No Git
 * executable, personal paths, data directory or environment enters the build. */
export function sourceBuildIdentity(root) {
  const files = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const next = relative + "/" + entry.name;
      if (entry.isSymbolicLink()) throw Error("build_source_link_forbidden");
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) files.push(next);
    }
  };
  for (const relative of ["electron", "src", "public/app"]) walk(relative);
  const hash = createHash("sha1");
  for (const relative of files.sort())
    hash
      .update(relative)
      .update("\0")
      .update(
        createHash("sha256")
          .update(fs.readFileSync(path.join(root, relative)))
          .digest("hex"),
      )
      .update("\n");
  return hash.digest("hex");
}
