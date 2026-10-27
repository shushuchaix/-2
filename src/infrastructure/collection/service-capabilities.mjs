const error = (code) => Object.assign(Error(code), { code });
export const WEIBO_READ_COMMANDS = Object.freeze({
  "search/statuses/limited": {
    group: "search",
    action: "statuses/limited",
    body: false,
  },
  "statuses/show_batch/biz": {
    group: "statuses",
    action: "show_batch/biz",
    body: true,
  },
});
export const OFFICIAL_WEIBO_BASIS = Object.freeze({
  package: "@weibo-ai/weibo-cli",
  version: "0.9.8",
  license: "MIT",
  integrity:
    "sha512-9BVBI+Z1ErzAcGDcUdsleyCGePEvRwiPJ3W2lyQQ8LdRxWXSl4wLhUzKRZMH7nTK3aqB0hPH/VDXWNS3tG5fug==",
  implementation: "official_http",
});
const unknownQuota = () => ({ status: "unknown", remaining: null });
const safePrice = (command) => {
  const price = command?.pricing;
  if (
    price?.configured !== true ||
    command?.price_type !== "per_record" ||
    !Number.isFinite(price.unit_price) ||
    price.unit_price < 0
  )
    return { status: "unknown" };
  return {
    status: price.unit_price === 0 ? "free" : "paid",
    unitPrice: price.unit_price,
    currency: /^(?:credit|CNY|USD)$/.test(price.currency)
      ? price.currency
      : "unknown",
  };
};
/** Fixed HTTP operations verified against official 0.9.8, no CLI/keychain access. */
export function createWeiboCapabilityRunner({ request, credentialStore } = {}) {
  return {
    async run({ scope, credentialRef, operation, commandId, signal }) {
      if (
        !["doctor", "list_available", "show_read_command"].includes(
          operation,
        ) ||
        (operation === "show_read_command" && !WEIBO_READ_COMMANDS[commandId])
      )
        throw error("service_command_forbidden");
      if (!credentialRef || !credentialStore?.resolve)
        return {
          configured: false,
          ready: false,
          issues: [{ code: "service_unconfigured" }],
        };
      const credential = await credentialStore.resolve({
        scope,
        credentialRef,
        platform: "weibo",
      });
      if (
        credential?.ownerPackageId !== scope.packageId ||
        credential.platform !== "weibo"
      )
        throw error("service_credential_scope");
      if (
        typeof credential.accessToken !== "string" ||
        !credential.accessToken ||
        /[\r\n\0]/.test(credential.accessToken)
      )
        throw error("service_credential_invalid");
      const command = WEIBO_READ_COMMANDS[commandId],
        path =
          operation === "doctor"
            ? "/cli/whoami"
            : operation === "list_available"
              ? "/cli/commands?access=available"
              : "/cli/commands/" +
                encodeURIComponent(command.group) +
                "/" +
                encodeURIComponent(command.action);
      const response = await request("https://open.weibo.com/cli/api" + path, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + credential.accessToken,
        },
        signal,
        maxBytes: 1048576,
        maxRetries: 0,
        diagnosticContext: {
          sourceId: "weibo-official",
          endpointKind: "capability",
        },
      });
      if (response.status !== 200)
        return {
          configured: true,
          ready: false,
          issues: [
            {
              code: [401, 403].includes(response.status)
                ? "service_auth_required"
                : "service_unavailable",
            },
          ],
        };
      let data;
      try {
        data = JSON.parse(response.text);
      } catch {
        return {
          configured: true,
          ready: false,
          issues: [{ code: "service_response_invalid" }],
        };
      }
      if (operation === "doctor") {
        const verified =
            data.user?.developer_identity?.is_verified === true ||
            data.user?.developer_identity?.status === "verified",
          kind = data.service_status?.kind;
        return {
          configured: true,
          ready: verified && ["formal_active", "trial_active"].includes(kind),
          serviceKind: ["formal_active", "trial_active"].includes(kind)
            ? kind
            : "unknown",
          quota: unknownQuota(),
        };
      }
      if (operation === "list_available")
        return {
          commands: (Array.isArray(data.commands) ? data.commands : [])
            .filter(
              (c) =>
                c?.access === "allowed" &&
                WEIBO_READ_COMMANDS[c.group + "/" + c.action],
            )
            .map((c) => ({
              group: c.group,
              action: c.action,
              access: "allowed",
            })),
        };
      const meta = data.command || data;
      if (meta.group !== command.group || meta.action !== command.action)
        return { issues: [{ code: "service_command_mismatch" }] };
      return {
        commandId,
        pricing: safePrice(meta),
        bodyVerified: false,
        quota: unknownQuota(),
      };
    },
  };
}
export async function probeReadService({
  scope,
  platform,
  credentialRef,
  accountId,
  runner,
}) {
  const base = {
    scope: {
      packageId: scope.packageId,
      targetRevisionId: scope.targetRevisionId,
    },
    platform,
    configured: false,
    enabled: false,
    availableReadCommands: [],
    quota: unknownQuota(),
    pricingState: "unknown",
    bodyCapability: false,
    automaticCalls: 0,
    issues: [],
  };
  if (!runner || !credentialRef)
    return { ...base, issues: [{ code: "service_unconfigured" }] };
  if (platform === "wechat") {
    const result = await runner.run({
      scope,
      credentialRef,
      accountId,
      operation: "wechat_capability",
    });
    const own =
      result.permissionVerified === true &&
      accountId &&
      result.requestedAccount === accountId &&
      result.authorizedAccounts?.includes(accountId);
    return {
      ...base,
      configured: result.configured === true,
      bodyCapability: !!own && result.bodyVerified === true,
      issues: [
        {
          code: own
            ? "service_quota_unknown"
            : "publication_permission_unverified",
        },
      ],
    };
  }
  if (platform !== "weibo") throw error("service_platform_invalid");
  const doctor = await runner.run({
    scope,
    credentialRef,
    operation: "doctor",
  });
  if (!doctor.ready)
    return {
      ...base,
      configured: doctor.configured === true,
      issues: [
        {
          code: doctor.issues?.some((i) => i.code === "service_unconfigured")
            ? "service_unconfigured"
            : "service_auth_required",
        },
      ],
    };
  const list = await runner.run({
      scope,
      credentialRef,
      operation: "list_available",
    }),
    commands = [],
    pricing = [];
  for (const item of Array.isArray(list.commands) ? list.commands : []) {
    const commandId = item?.group + "/" + item?.action;
    if (
      item?.access !== "allowed" ||
      !WEIBO_READ_COMMANDS[commandId] ||
      commands.includes(commandId)
    )
      continue;
    const detail = await runner.run({
      scope,
      credentialRef,
      operation: "show_read_command",
      commandId,
    });
    if (detail.commandId !== commandId) continue;
    commands.push(commandId);
    pricing.push(detail.pricing?.status || "unknown");
  }
  return {
    ...base,
    configured: true,
    availableReadCommands: commands,
    pricingState:
      pricing.length && pricing.every((p) => p === "free")
        ? "free"
        : pricing.includes("paid")
          ? "paid"
          : "unknown",
    issues: [
      { code: "service_quota_unknown" },
      { code: "service_body_unverified" },
    ],
    basis: OFFICIAL_WEIBO_BASIS,
  };
}
export async function enableReadService({
  scope,
  serviceId,
  confirmedCapability,
  paidServiceAcknowledged = false,
}) {
  const c = confirmedCapability;
  if (
    !c ||
    c.scope?.packageId !== scope.packageId ||
    c.scope.targetRevisionId !== scope.targetRevisionId ||
    c.platform !== (serviceId === "weibo-official" ? "weibo" : "wechat")
  )
    throw error("service_capability_scope");
  if (
    c.quota?.status !== "verified" ||
    !Number.isSafeInteger(c.quota.remaining) ||
    c.quota.remaining <= 0
  )
    throw error("service_quota_unknown");
  if (!c.bodyCapability) throw error("service_body_unverified");
  if (c.pricingState === "unknown") throw error("service_pricing_unknown");
  if (c.pricingState === "paid" && !paidServiceAcknowledged)
    throw error("service_paid_acknowledgement");
  return {
    ...c,
    enabled: true,
    automaticCalls: c.quota.remaining,
    paidServiceAcknowledged:
      c.pricingState === "paid" && paidServiceAcknowledged,
  };
}
