const unavailable = () =>
  Object.assign(Error("未核实本包对公众号的官方发布读取权限。"), {
    code: "publication_permission_unverified",
  });
export default {
  id: "wechat-authorized",
  name: "公众号官方授权读取（可选）",
  optionalService: true,
  platform: "wechat",
  defaultConfig: { enabled: false },
  configSchema: { enabled: "boolean" },
  capabilities: {
    body: false,
    resumablePages: false,
    optional: true,
    externalPricing: true,
    ownAccountOnly: true,
  },
  async collect() {
    throw unavailable();
  },
  async fetchDetail() {
    throw unavailable();
  },
  async probe() {
    return {
      sourceId: "wechat-authorized",
      siteId: "wechat-authorized",
      status: "unavailable",
      sampleCount: 0,
      issues: [{ code: "publication_permission_unverified" }],
      capabilities: { body: "unverified" },
    };
  },
};
