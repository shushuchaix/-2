import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installClosedPipeGuard } from "../../electron/process-output.mjs";
import { spawn } from "node:child_process";

test("closed console pipe does not crash desktop main process", () => {
  const stdout = new EventEmitter(),
    stderr = new EventEmitter();
  const dispose = installClosedPipeGuard({ stdout, stderr });
  for (const stream of [stdout, stderr])
    assert.doesNotThrow(() =>
      stream.emit(
        "error",
        Object.assign(Error("broken pipe"), { code: "EPIPE" }),
      ),
    );
  dispose();
  assert.equal(stdout.listenerCount("error"), 0);
  assert.equal(stderr.listenerCount("error"), 0);
});
test("unrelated output failures remain visible", () => {
  const stdout = new EventEmitter(),
    stderr = new EventEmitter(),
    dispose = installClosedPipeGuard({ stdout, stderr });
  const error = Object.assign(Error("unrelated failure"), { code: "EIO" });
  assert.throws(
    () => stdout.emit("error", error),
    (e) => e === error,
  );
  dispose();
});
test("real child finishes after its parent closes the output pipe", async () => {
  const moduleUrl = new URL(
    "../../electron/process-output.mjs",
    import.meta.url,
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {installClosedPipeGuard} from " +
        JSON.stringify(moduleUrl) +
        ';installClosedPipeGuard();process.send("ready");process.on("message",()=>{process.stdout.write("synthetic output");setTimeout(()=>process.exit(0),80)});',
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  child.once("message", () => {
    child.stdout.destroy();
    child.send("write");
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
});
