import { createApiClient } from "./api.js";
import { createStore } from "./state.js";
import { createRouter } from "./router.js";
import { mountShell } from "./components/shell.js";
import { message } from "./components/dom.js";
const api = createApiClient(),
  store = createStore();
let page,
  version = 0;
const modules = {
  "/workbench": ["workbench", "mountWorkbenchPage"],
  "/jobs": ["jobs", "mountJobsPage"],
  "/applications": ["applications", "mountApplicationsPage"],
  "/profiles": ["profiles", "mountProfilesPage"],
  "/settings": ["settings", "mountSettingsPage"],
};
const router = createRouter({
  async onRoute(route) {
    const current = ++version;
    page?.destroy();
    store.dispatch({ type: "route", route });
    message(shell.content, "正在读取工作区…");
    try {
      const [file, name] = modules[route],
        module = await import("./pages/" + file + ".js");
      if (current !== version) return;
      page = module[name]({
        root: shell.content,
        api,
        store,
        desktopBridge: globalThis.desktopBridge,
      });
      shell.content.focus();
    } catch (error) {
      if (current === version) message(shell.content, error.message, true);
    }
  },
});
const shell = mountShell({
  root: document.getElementById("app"),
  store,
  router,
  api,
});
router.start();
