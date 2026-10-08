import { inputError } from "../../public/js/validation-rules.js";
import { UUID_RE, packageError } from "../domain/packages.mjs";
const id = (value, field) => {
  if (!UUID_RE.test(value || ""))
    throw inputError({ [field]: "数据包或归档标识无效，请刷新后重试。" });
  return value;
};
export async function handleTrashRequest(req, res, context) {
  const url = new URL(req.url, "http://localhost"),
    route = url.pathname.slice("/api/v2".length);
  if (!url.pathname.startsWith("/api/v2/trash")) return false;
  const service = context.trashService;
  if (!service)
    throw packageError("trash_unavailable", "回收站服务尚未就绪。", 503);
  const send = (data) => context.http.json(req, res, 200, data),
    body = () => context.http.readJson(req);
  if (route === "/trash" && req.method === "GET") {
    for (const key of url.searchParams.keys())
      if (!["kind", "search", "sort"].includes(key))
        throw inputError({ filters: "回收站筛选条件无效。" });
    send({ items: await service.list(Object.fromEntries(url.searchParams)) });
    return true;
  }
  if (route === "/trash/archive" && req.method === "POST") {
    const input = await body();
    id(input.packageId, "packageId");
    send(await service.archive(input));
    return true;
  }
  if (route === "/trash/restore" && req.method === "POST") {
    const input = await body();
    id(input.packageId, "packageId");
    id(input.archiveId, "archiveId");
    send(await service.restore(input));
    return true;
  }
  if (route === "/trash/preview" && req.method === "POST") {
    const input = await body();
    if (input.expiredOnly !== undefined)
      throw inputError({ expiredOnly: "到期批次仅供内部自动清理使用。" });
    for (const value of input.packageIds || []) id(value, "packageIds");
    send(await service.preview(input));
    return true;
  }
  const match = /^\/trash\/([0-9a-f-]+)$/.exec(route);
  if (match && req.method === "GET") {
    send(await service.get(id(match[1], "packageId")));
    return true;
  }
  return false;
}
