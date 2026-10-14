import { finished } from "node:stream/promises";

// ASAR 3 resolves creation with an ending Writable, before its final bytes
// have necessarily reached disk. Later versions may instead return void.
export async function drainArchiveWrite(creation) {
  const output = await creation;
  if (typeof output?.on === "function") await finished(output);
}
