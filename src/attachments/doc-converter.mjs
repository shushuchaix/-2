import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
function run(executable, args, { signal, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      }),
      timer = setTimeout(() => {
        child.kill();
        reject(
          Object.assign(Error("Conversion timeout"), {
            code: "doc_conversion_timeout",
          }),
        );
      }, timeoutMs);
    let output = "";
    const abort = () => {
      child.kill();
      reject(signal.reason || Error("Cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (b) => {
      output = (output + b.toString()).slice(0, 4096);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      code === 0
        ? resolve(output)
        : reject(
            Object.assign(Error("Conversion failed"), {
              code: "doc_conversion_failed",
            }),
          );
    });
  });
}
export function createDocConverter({ executable, cleanup } = {}) {
  let verified = null;
  return {
    async convert({ bytes, ref, attemptId, signal }) {
      if (
        !executable ||
        !path.isAbsolute(executable) ||
        !(await fs.stat(executable).catch(() => null))?.isFile()
      )
        throw Object.assign(Error("DOC converter unavailable"), {
          code: "doc_converter_unavailable",
        });
      verified ||= run(executable, ["--version"], { signal })
        .then((output) => {
          if (!/LibreOffice/i.test(output))
            throw Object.assign(Error("DOC converter unsupported"), {
              code: "doc_converter_unavailable",
            });
          return output;
        })
        .catch((error) => {
          verified = null;
          throw error;
        });
      await verified;
      const base = attemptId,
        input = await cleanup.register({
          scope: ref.scope,
          activityId: ref.activityId,
          attemptId,
          relativePath: base + "/input.doc",
        }),
        output = await cleanup.register({
          scope: ref.scope,
          activityId: ref.activityId,
          attemptId,
          relativePath: base + "/output",
        }),
        profile = await cleanup.register({
          scope: ref.scope,
          activityId: ref.activityId,
          attemptId,
          relativePath: base + "/profile",
        });
      await fs.mkdir(path.dirname(input), { recursive: true });
      await fs.mkdir(output);
      await fs.mkdir(profile);
      await fs.writeFile(input, bytes, { flag: "wx" });
      await run(
        executable,
        [
          "-env:UserInstallation=" + pathToFileURL(profile).href,
          "--headless",
          "--convert-to",
          "docx",
          "--outdir",
          output,
          input,
        ],
        { signal },
      );
      const result = await fs.readFile(path.join(output, "input.docx"));
      if (result.length > 20971520)
        throw Object.assign(Error("Conversion size limit"), {
          code: "attachment_expansion_limit",
        });
      return result;
    },
  };
}
