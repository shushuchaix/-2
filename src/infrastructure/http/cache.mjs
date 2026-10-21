export function createResponseCache({
  ttlMs = 300000,
  clock = { now: Date.now },
  maxEntries = 1000,
} = {}) {
  const values = new Map();
  return {
    get(key) {
      const entry = values.get(key);
      if (!entry) return null;
      if (entry.expires <= clock.now()) {
        values.delete(key);
        return null;
      }
      return structuredClone(entry.value);
    },
    set(key, value) {
      if (values.size >= maxEntries) values.delete(values.keys().next().value);
      values.set(key, {
        expires: clock.now() + ttlMs,
        value: structuredClone(value),
      });
    },
    clear() {
      values.clear();
    },
  };
}
