#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, ensureDataDirs } from "./config.mjs";
import { getDefaultApplicationContext } from "./application/context.mjs";
import { runPipeline, saveRun } from "./pipeline.mjs";
import { extractResumeText } from "./resume/extract-text.mjs";
import { exportResult } from "./export.mjs";
import {resolveLegacyScope} from './application/legacy-scope.mjs';
const booleans = new Set([
  "help",
  "h",
  "no-llm",
  "no-intern",
  "all-years",
  "rules",
]);
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else {
      const key = a.slice(2);
      out[key] =
        booleans.has(key) || !argv[i + 1] || argv[i + 1].startsWith("--")
          ? true
          : argv[++i];
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2)),
  split = (v) =>
    String(v || "")
      .split(/[,，、;；\s]+/)
      .filter(Boolean);
let cliContext;
async function main() {
  if (args.help || args.h) {
    console.log(
      "Job Radar v2\n旧参数：--resume 文件（或位置参数） / --text 文本 --cities 列表 --keywords 列表 --year 年份 --no-intern --all-years --format json|csv|md --out 文件 --no-llm --top N\n新命令：targets list；runs start --target ID或revision --rules；runs show ID；applications set JOB_ID --status STATUS [--note 文本]；sources probe SOURCE_ID [--site SITE_ID]",
    );
    return;
  }
  ensureDataDirs();
  const cfg = loadConfig({ quiet: true }),
    context = cliContext=await getDefaultApplicationContext(cfg),
    [group, command, id] = args._;
  if (group === "targets" && command === "list") {
    console.log(
      JSON.stringify(
        { targets: await context.workspaceService.listTargets() },
        null,
        2,
      ),
    );
    return;
  }
  if (group === "runs" && command === "start") {
    const requested = String(args.target || "");
    const revisions = await context.workspaceService.listTargets(),
      target =
        revisions.find((t) => t.revisionId === requested) ||
        revisions.filter((t) => t.targetId === requested).at(-1);
    if (!target) throw Error("Target not found");
    const scope=resolveLegacyScope(target.revisionId===requested?{targetRevisionId:requested}:{targetId:requested},await context.repository.read(),context.repository.clock.now());
    const started = await context.runService.startRun({
        scope,
        targetRevisionId: target.revisionId,
        mode: args.rules ? "rules" : cfg.deepseek.apiKey ? "ai" : "rules",
      }),
      result = await context.runService.waitForRun(started.runId,scope);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (group === "runs" && command === "show") {
    const scope=resolveLegacyScope({runId:id,...(args.target?{targetRevisionId:String(args.target)}:{})},await context.repository.read(),context.repository.clock.now());
    console.log(JSON.stringify(await context.runService.getRun(id,scope), null, 2));
    return;
  }
  if (group === "applications" && command === "set") {
    if (!args.status) throw Error("--status required");
    const w=await context.repository.read(),scope=resolveLegacyScope({...(w.applications[id]?{applicationId:id}:{jobId:id}),...(args.target?{targetRevisionId:String(args.target)}:{})},w,context.repository.clock.now());
    console.log(
      JSON.stringify(
        await (w.schemaVersion===3&&!w.applications[id]?context.jobService.updateJobApplication:context.jobService.updateApplication)(id, {
          status: args.status,
          ...(Object.hasOwn(args, "note")
            ? { note: String(args.note === true ? "" : args.note) }
            : {}),
        },scope),
        null,
        2,
      ),
    );
    return;
  }
  if (group === "sources" && command === "probe") {
    console.log(
      JSON.stringify(await context.sourceService.probe(id, args.site), null, 2),
    );
    return;
  }
  if (["targets", "runs", "applications", "sources"].includes(group))
    throw Error("Unknown command; use --help");
  let text;
  if (args.text) text = String(args.text);
  else {
    const file = args.resume || args._[0];
    if (!file) throw Error("请指定 --resume 文件或 --text 正文");
    const abs = path.resolve(process.cwd(), file),
      buffer = await fs.readFile(abs);
    if (buffer.length > 20 * 1024 * 1024) throw Error("简历文件超过20MB");
    const parsed = await extractResumeText(buffer, path.basename(abs));
    text = parsed.text;
    console.error(
      "已读取 " +
        path.basename(abs) +
        " · " +
        parsed.format +
        " · " +
        text.length +
        "字",
    );
  }
  const options = { useLlm: args["no-llm"] ? false : undefined };
  if (Object.hasOwn(args, "cities"))
    options.cities = split(args.cities === true ? "" : args.cities);
  if (args.keywords) options.titleKeywords = split(args.keywords);
  if (args["all-years"]) options.graduationYear = "";
  else if (args.year)
    options.graduationYear = String(args.year).replace(/届$/, "");
  if (args["no-intern"]) options.includeInternship = false;
  const result = await runPipeline({
      resumeText: text,
      cfg,
      context,
      options,
      onEvent: (ev) => {
        if (ev.type === "stage") console.error("▶ " + ev.label);
        else if (ev.type === "log") console.error(ev.message);
      },
    }),
    saved = await saveRun(result);
  console.error("结果已保存：" + saved);
  const format = String(
    args.format ||
      (args.out?.endsWith(".csv")
        ? "csv"
        : args.out?.endsWith(".md")
          ? "md"
          : "json"),
  );
  if (!["json", "csv", "md"].includes(format)) throw Error("Invalid format");
  const exported = exportResult(result, format);
  if (args.out) {
    await fs.writeFile(path.resolve(process.cwd(), args.out), exported.body);
    console.error("已导出：" + args.out);
  } else console.log(exported.body);
  const top = Number(args.top) || 15;
  for (const item of result.jobs.slice(0, top))
    console.error(
      item.score +
        "分 · " +
        item.title +
        " · " +
        (item.company || "公司未提供"),
    );
}
main().catch((error) => {
  console.error("运行失败：" + error.message);
  process.exitCode = 1;
}).finally(async()=>{try{await cliContext?.close?.();}catch(error){console.error('关闭失败：'+error.message);process.exitCode=1;}});
