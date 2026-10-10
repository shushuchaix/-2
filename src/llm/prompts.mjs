import { getPromptDefinition, renderPrompt } from "./prompt-registry.mjs";
export const PROMPT_VERSION = getPromptDefinition("matching").promptVersion;
export const SCHEMA_VERSION = getPromptDefinition("matching").schemaVersion;
export function evaluationPrompt(profile, records) {
  return renderPrompt("matching", { profile, records });
}
