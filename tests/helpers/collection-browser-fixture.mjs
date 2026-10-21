import { EventEmitter } from "node:events";
export function collectionBrowserFixture({ executeJavaScript } = {}) {
  const values = new Map(),
    windows = [];
  let id = 0;
  const session = {
    fromPartition(partition) {
      if (!values.has(partition)) {
        const ses = new EventEmitter();
        Object.assign(ses, {
          partition,
          cookieValues: [],
          cookies: {
            get: async () => ses.cookieValues,
            set: async (cookie) => ses.cookieValues.push(cookie),
          },
          webRequest: {
            onBeforeRequest: (filter, cb) => {
              ses.before = filter === null ? null : cb;
            },
            onHeadersReceived: (filter, cb) => {
              ses.headers = filter === null ? null : cb;
            },
          },
          setPermissionRequestHandler: () => {},
          setPermissionCheckHandler: () => {},
          setProxy: async (p) => {
            ses.proxy = p;
          },
          closeAllConnections: async () => {},
          clearStorageData: async (input) => {
            if (!input) ses.cookieValues = [];
          },
          clearCache: async () => {},
        });
        values.set(partition, ses);
      }
      return values.get(partition);
    },
  };
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        id: ++id,
        session: session.fromPartition(options.webPreferences.partition),
        setWebRTCIPHandlingPolicy: () => {},
        setWindowOpenHandler: () => {},
        getURL: () => this.url,
        executeJavaScript: async (code) =>
          executeJavaScript
            ? executeJavaScript(code, this)
            : this.html ||
              '<div id="captcha">验证码</div><title>安全验证</title>',
      });
      windows.push(this);
    }
    async loadURL(url) {
      this.url = url;
      const ses = this.webContents.session;
      if (ses.before) {
        const result = await new Promise((resolve) =>
          ses.before(
            {
              url,
              method: "GET",
              resourceType: "mainFrame",
              webContentsId: this.webContents.id,
            },
            resolve,
          ),
        );
        if (result.cancel) throw Error("request_blocked");
      }
      ses.headers?.(
        { statusCode: 200, resourceType: "mainFrame", responseHeaders: {} },
        () => {},
      );
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      if (!this.destroyed) {
        this.destroyed = true;
        this.emit("closed");
      }
    }
  }
  const egressProxy = {
    start: async () => ({ proxyUrl: "http://127.0.0.1:12345" }),
    createClient: () => ({
      username: "synthetic",
      password: "synthetic",
      grant: () => {},
      snapshot: () => ({ bytes: 0 }),
      revoke: () => {},
    }),
    stop: async () => {},
  };
  return { session, BrowserWindow, egressProxy, values, windows };
}
