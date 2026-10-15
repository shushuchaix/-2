// Local one-use request capability. It is removed by Electron before HTTP send.
export const BOSS_OPERATION_HEADER = "X-RJR-Owned-Operation";
export const validBossOperationToken = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function bossOperationHeader(headers = {}) {
  const names = Object.keys(headers).filter(
    (name) => name.toLowerCase() === BOSS_OPERATION_HEADER.toLowerCase(),
  );
  return {
    present: names.length > 0,
    value: names.length === 1 ? headers[names[0]] : undefined,
  };
}
export function stripBossOperationHeader(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== BOSS_OPERATION_HEADER.toLowerCase(),
    ),
  );
}
