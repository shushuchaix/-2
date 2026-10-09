import { businessScope } from "./package-business-routes.mjs";
import { identifier, userCredentials } from "./validation.mjs";
import { packageError } from "../domain/packages.mjs";
export async function handleCollectionRequest(req, res, context) {
  const url = new URL(req.url, "http://localhost");
  if (!/^\/api\/v2\/collections(?:\/|$)/.test(url.pathname)) return false;
  if (!context.collectionService)
    throw packageError(
      "collection_unavailable",
      "当前工作区不支持持续采集。",
      409,
    );
  const service = context.collectionService,
    params = Object.fromEntries(url.searchParams),
    send = (status, value) => context.http.json(req, res, status, value);
  if (url.pathname === "/api/v2/collections") {
    if (req.method === "GET")
      send(200, {
        collections: await service.list({ scope: businessScope(params) }),
      });
    else if (req.method === "POST") {
      const input = await context.http.readJson(req),
        mode = input.mode || "rules";
      send(
        202,
        await service.start({
          scope: businessScope(input),
          options: { ...input.options, mode, requestId: input.requestId },
          credentials:
            mode === "rules" ? {} : userCredentials(input, context.cfg),
        }),
      );
    } else return false;
    return true;
  }
  const match = url.pathname.match(
    /^\/api\/v2\/collections\/([^/]+)(?:\/(pause|resume|cancel|limits))?$/,
  );
  if (!match) return false;
  const activityId = identifier(decodeURIComponent(match[1]));
  if (!match[2] && req.method === "GET") {
    send(200, await service.get({ scope: businessScope(params), activityId }));
    return true;
  }
  if (!["POST", "PUT"].includes(req.method)) return false;
  const input = await context.http.readJson(req),
    ref = { scope: businessScope(input), activityId };
  if (req.method === "POST" && ["pause", "cancel"].includes(match[2]))
    send(200, await service[match[2]](ref));
  else if (req.method === "POST" && match[2] === "resume")
    send(
      202,
      await service.resume({
        ref,
        requestId: input.requestId,
        replan: input.replan === true,
        mode: input.mode || (input.useAI ? "ai" : undefined),
        credentials: input.useAI ? userCredentials(input, context.cfg) : {},
      }),
    );
  else if (req.method === "PUT" && match[2] === "limits")
    send(
      200,
      await service.adjustLimits({
        ref,
        limits: input.limits,
        expectedRevision: input.expectedRevision,
      }),
    );
  else return false;
  return true;
}
