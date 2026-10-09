const unavailable = () =>
  Object.assign(Error("微博官方读取未开通或额度尚未核实。"), {
    code: "service_unconfigured",
  });
export default {
  id: "weibo-official",
  name: "微博官方读取（可选）",
  optionalService: true,
  platform: "weibo",
  defaultConfig: { enabled: false },
  configSchema: { enabled: "boolean" },
  capabilities: {
    body: false,
    resumablePages: false,
    optional: true,
    externalPricing: true,
  },
  async collect() {
    throw unavailable();
  },
  async fetchDetail() {
    throw unavailable();
  },
  async probe() {
    return {
      sourceId: "weibo-official",
      siteId: "weibo-official",
      status: "unavailable",
      sampleCount: 0,
      issues: [{ code: "service_unconfigured" }],
      capabilities: { body: "unverified" },
    };
  },
};
