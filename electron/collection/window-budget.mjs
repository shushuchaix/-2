import { randomUUID } from "node:crypto";

const requestLimit = 60;
const dnsByteLimit = 65536;
const windowByteLimit = 20971520;
const failure = (code) =>
  Object.assign(Error("独立采集窗口额度不可用。"), { code, retryable: false });
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

/** Persist the complete bounded allowance before a window may send anything.
 * A process crash leaves all slots charged as unknown. Only a drained window
 * can refund never-issued slots and confirm completed physical requests. */
export async function createBrowserWindowBudget({
  ledger,
  ref,
  token,
  operationLease,
  signal,
}) {
  signal?.throwIfAborted();
  const usage = await ledger.snapshot(ref);
  signal?.throwIfAborted();
  const byteLimit = Math.min(
    windowByteLimit,
    usage.maxPageBytes ?? windowByteLimit,
    usage.maxAttachmentBytes ?? windowByteLimit,
    (usage.maxTotalAttachmentBytes ?? 209715200) - usage.usedBytes,
  );
  const capacity = Math.min(
    requestLimit,
    usage.maxPageRequests ?? requestLimit,
    usage.maxRequests - usage.usedRequests,
    Math.floor((byteLimit - 1) / dnsByteLimit),
  );
  if (capacity < 1)
    throw Object.assign(failure("source_budget_exhausted"), {
      budgetKind:
        usage.maxRequests <= usage.usedRequests ? "requests" : "attachments",
    });
  const maxWireBytes = byteLimit - capacity * dnsByteLimit;
  const bytesId = randomUUID();
  const slots = Array.from({ length: capacity }, () => ({
    reservationId: randomUUID(),
    assigned: false,
  }));
  const args = { ref, token, operationLease };
  await ledger.reserveBatch({
    ...args,
    reservations: [
      {
        reservationId: bytesId,
        kind: "browser",
        requestUpperBound: 0,
        bytesUpperBound: maxWireBytes,
      },
      ...slots.map((s) => ({
        reservationId: s.reservationId,
        kind: "browser",
        requestUpperBound: 1,
        bytesUpperBound: dnsByteLimit,
      })),
    ],
  });
  let next = 0,
    closing;
  const byId = new Map(slots.map((s) => [s.reservationId, s]));
  return {
    maxWireBytes,
    ledger: {
      async reserve(input) {
        signal?.throwIfAborted();
        if (closing) throw failure("collection_cancelled");
        if (
          !["browser", "resource", "dns"].includes(input.kind) ||
          input.requestUpperBound !== 1 ||
          !integer(input.bytesUpperBound ?? 0) ||
          (input.bytesUpperBound || 0) > dnsByteLimit
        )
          throw failure("collection_reservation_invalid");
        if (next >= slots.length) throw failure("source_budget_exhausted");
        const slot = slots[next++];
        Object.assign(slot, {
          assigned: true,
          kind: input.kind,
          bytesUpperBound: input.bytesUpperBound || 0,
        });
        return { ...input, reservationId: slot.reservationId };
      },
      async settle({ reservationId, verifiedUsage }) {
        const slot = byId.get(reservationId);
        if (closing || !slot?.assigned || slot.verifiedUsage) return;
        if (
          verifiedUsage?.requests === 1 &&
          integer(verifiedUsage.bytes) &&
          verifiedUsage.bytes <= slot.bytesUpperBound
        )
          slot.verifiedUsage = { requests: 1, bytes: verifiedUsage.bytes };
      },
    },
    close({ bytes }) {
      if (closing) return closing;
      closing = Promise.resolve().then(() =>
        ledger.settleBatch({
          ...args,
          draining: true,
          settlements: [
            {
              reservationId: bytesId,
              ...(integer(bytes) && bytes <= maxWireBytes
                ? { verifiedUsage: { requests: 0, bytes } }
                : {}),
            },
            ...slots.map((slot) => ({
              reservationId: slot.reservationId,
              ...(slot.assigned
                ? {
                    kind: slot.kind,
                    ...(slot.verifiedUsage
                      ? { verifiedUsage: slot.verifiedUsage }
                      : {}),
                  }
                : { verifiedUsage: { requests: 0, bytes: 0 } }),
            })),
          ],
        }),
      );
      return closing;
    },
  };
}
