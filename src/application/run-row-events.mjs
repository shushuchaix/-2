import { randomUUID } from "node:crypto";
import { packageError } from "../domain/packages.mjs";
import { rowKey } from "../infrastructure/storage/sqlite-records.mjs";
const terminal = new Set([
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
]);
export function createRowRunEventHub({
  repository,
  clock = repository.clock,
  maxBuffered = 200,
  pollIntervalMs = 1000,
}) {
  const listeners = new Map(),
    at = () => new Date(clock.now()).toISOString();
  function runIn(view, runId, scope) {
    const run = view.rows.runs?.[runId];
    if (
      !run ||
      run.ownerPackageId !== scope?.packageId ||
      view.indexes.runs?.[runId]?.targetRevisionId !== scope?.targetRevisionId
    )
      throw packageError("package_scope_mismatch", "运行不属于此目标版本。");
    return run;
  }
  async function state(runId, scope, afterSeq, { headOnly = false } = {}) {
    if (!scope?.packageId || !scope?.targetRevisionId)
      throw packageError("version_scope_required", "请选择准确的目标版本。");
    const select = [
      { collection: "runs", ownerPackageId: scope?.packageId, ids: [runId] },
    ];
    if (!headOnly)
      select.push({
        collection: "runEvents",
        ownerPackageId: scope?.packageId,
        where: { runId, seq: { gt: afterSeq } },
        orderBy: "seq",
        direction: "asc",
        limit: maxBuffered,
      });
    const view = await repository.readView({ select }, { scope }),
      run = runIn(view, runId, scope);
    return {
      run,
      events: Object.values(view.rows.runEvents || {}).sort(
        (a, b) => a.seq - b.seq,
      ),
      pageInfo: view.pageInfo,
    };
  }
  const hub = {
    async publish(runId, type, payload, scope) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const { run } = await state(runId, scope, 0, { headOnly: true }),
          seq = (run.lastSeq || 0) + 1;
        if (!Number.isSafeInteger(seq))
          throw packageError("sqlite_sequence_exhausted", "事件序号已耗尽。");
        const id = rowKey(runId, "events", String(seq - 1)),
          event = {
            schemaVersion: 2,
            recordId: randomUUID(),
            ownerPackageId: scope.packageId,
            runId,
            seq,
            type,
            at: at(),
            payload: structuredClone(payload),
          };
        try {
          await repository.transaction(
            {
              select: [
                {
                  collection: "runs",
                  ownerPackageId: scope.packageId,
                  ids: [runId],
                },
                {
                  collection: "runEvents",
                  ownerPackageId: scope.packageId,
                  ids: [id],
                },
                {
                  collection: "runEvents",
                  ownerPackageId: scope.packageId,
                  where: { runId, seq: { lte: seq - maxBuffered } },
                  limit: 200,
                },
              ],
            },
            (tx) => {
              const current = runIn(tx.view, runId, scope);
              if ((current.lastSeq || 0) + 1 !== seq)
                throw packageError(
                  "run_event_conflict",
                  "事件序号已变化。",
                  409,
                );
              current.lastSeq = seq;
              tx.putRow({ collection: "runs", id: runId, value: current });
              for (const [key, value] of Object.entries(
                tx.view.rows.runEvents || {},
              ))
                if (value.seq <= seq - maxBuffered)
                  tx.deleteRow({ collection: "runEvents", id: key });
              tx.putRow({
                collection: "runEvents",
                id,
                ownerPackageId: scope.packageId,
                parent: { collection: "runs", id: runId, path: "events" },
                runId,
                targetRevisionId: scope.targetRevisionId,
                ordinal: seq - 1,
                value: event,
              });
            },
            { scope },
          );
          for (const subscriber of listeners.get(runId) || [])
            subscriber.enqueue(event);
          return event;
        } catch (error) {
          if (error.code !== "run_event_conflict" || attempt === 7) throw error;
        }
      }
    },
    async getHead(runId, scope) {
      const { run } = await state(runId, scope, 0, { headOnly: true });
      return { runId, seq: run.lastSeq || 0, status: run.status };
    },
    async getSnapshot(runId, scope) {
      const { run, events } = await state(runId, scope, 0),
        view = await repository.readView(
          {
            select: [
              {
                collection: "observations",
                ownerPackageId: scope.packageId,
                where: { runId },
                limit: 200,
              },
              {
                collection: "evaluations",
                ownerPackageId: scope.packageId,
                where: { runId },
                limit: 200,
              },
            ],
          },
          { scope },
        );
      const observations = Object.values(view.rows.observations || {}),
        ids = [...new Set(observations.map((o) => o.jobId))],
        jobs = ids.length
          ? await repository.readView(
              {
                select: [
                  { collection: "jobs", ownerPackageId: scope.packageId, ids },
                ],
              },
              { scope },
            )
          : { rows: {} };
      const records = ids.map((id) => {
        const fact = observations
          .filter((o) => o.jobId === id)
          .sort((a, b) =>
            String(b.observedAt).localeCompare(String(a.observedAt)),
          )[0];
        return {
          ...jobs.rows.jobs[id],
          canonical:
            fact?.fields || fact?.record || jobs.rows.jobs[id]?.canonical,
        };
      });
      return {
        schemaVersion: 2,
        runId,
        seq: run.lastSeq || 0,
        type: "snapshot",
        at: at(),
        payload: {
          run: { ...run, events },
          jobs: records,
          evaluations: Object.values(view.rows.evaluations || {}),
          snapshotPage: {
            limit: 200,
            hasMore: Object.values(view.pageInfo || {}).some(
              (page) => page?.hasMore,
            ),
          },
        },
      };
    },
    async subscribe(runId, { afterSeq = 0, onEvent, onClose, signal, scope }) {
      if (
        !Number.isSafeInteger(afterSeq) ||
        afterSeq < 0 ||
        typeof onEvent !== "function"
      )
        throw Error("Invalid event cursor");
      signal?.throwIfAborted();
      let closed = false,
        ready = false,
        pumping = false,
        polling = false,
        lastSeq = afterSeq,
        queue = [],
        poll;
      const unsubscribe = () => {
        if (closed) return;
        closed = true;
        queue = [];
        listeners.get(runId)?.delete(subscriber);
        clearInterval(poll);
        signal?.removeEventListener("abort", unsubscribe);
      };
      const fail = (error) => {
        if (closed) return;
        unsubscribe();
        try {
          onClose?.(error);
        } catch {}
      };
      async function pump() {
        if (pumping || closed) return;
        pumping = true;
        try {
          while (queue.length && !closed) {
            let event = queue.shift();
            await hub.getHead(runId, scope);
            if (event.type === "resync")
              event = await hub.getSnapshot(runId, scope);
            if (event.seq <= lastSeq && event.type !== "snapshot") continue;
            if (event.type === "snapshot" && event.seq < lastSeq) continue;
            await onEvent(event);
            lastSeq = Math.max(lastSeq, event.seq);
          }
        } catch (error) {
          fail(error);
        } finally {
          pumping = false;
        }
      }
      const subscriber = {
        enqueue(event) {
          if (closed || (event.seq != null && event.seq <= lastSeq)) return;
          if (queue.length >= maxBuffered) queue = [{ type: "resync" }];
          else queue.push(event);
          if (ready) void pump();
        },
      };
      if (!listeners.has(runId)) listeners.set(runId, new Set());
      listeners.get(runId).add(subscriber);
      try {
        const current = await state(runId, scope, afterSeq);
        if (afterSeq > (current.run.lastSeq || 0))
          throw Error("Future event cursor seq");
        const pending = queue;
        queue = [];
        if (
          !current.events.length ||
          (afterSeq === (current.run.lastSeq || 0) &&
            terminal.has(current.run.status)) ||
          afterSeq < (current.events[0]?.seq || 1) - 1
        )
          queue.push(await hub.getSnapshot(runId, scope));
        else queue.push(...current.events);
        queue.push(
          ...pending.filter(
            (event) =>
              event.type === "resync" || event.seq > (current.run.lastSeq || 0),
          ),
        );
        ready = true;
        poll = setInterval(async () => {
          if (closed || polling) return;
          polling = true;
          try {
            // Every empty poll checks current scope/control and decodes one small run head only.
            const head = await hub.getHead(runId, scope);
            if (head.seq > lastSeq) {
              const next = await state(runId, scope, lastSeq);
              if (!next.events.length || lastSeq < next.events[0].seq - 1)
                subscriber.enqueue({ type: "resync" });
              else for (const event of next.events) subscriber.enqueue(event);
            }
          } catch (error) {
            fail(error);
          } finally {
            polling = false;
          }
        }, pollIntervalMs);
        poll.unref?.();
        signal?.addEventListener("abort", unsubscribe, { once: true });
        void pump();
        return unsubscribe;
      } catch (error) {
        unsubscribe();
        throw error;
      }
    },
  };
  return hub;
}
