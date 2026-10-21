import { createTestDocument, settle } from "./dom.mjs";
import { createStore } from "../../public/js/state.js";
export function uiFixture(handler) {
  const document = createTestDocument(),
    root = document.getElementById("root"),
    calls = [],
    store = createStore();
  const api = {
    async request(path, options = {}) {
      calls.push({ path, ...options });
      return handler(path, options, calls);
    },
  };
  return { document, root, calls, store, api, settle };
}
