import fs from "node:fs";
export const RANKING_POLICY = Object.freeze(
  JSON.parse(
    fs.readFileSync(new URL("./ranking-config.json", import.meta.url), "utf8"),
  ),
);
export const RULE_VERSION = RANKING_POLICY.ruleVersion;
