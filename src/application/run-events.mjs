import { resolveJobIds, resolveJobId } from "../domain/job-resolution.mjs";
import { selectRunJobFact } from "../domain/job-facts.mjs";
import {randomUUID} from 'node:crypto';
import {assertScope,assertOwned} from '../domain/packages.mjs';
import {packageWorkspace} from './package-job-service.mjs';
export function createRunEventHub({
  repository,
  clock = repository.clock,
  maxBuffered = 200,
}) {
  if (
    !Number.isSafeInteger(maxBuffered) ||
    maxBuffered < 1 ||
    maxBuffered > 200
  )
    throw Error("Invalid event buffer");
  const listeners = new Map();
  const at = () => new Date(clock.now()).toISOString();
  const hub = {
    async publish(runId, type, payload,scope) {
      const event = (
        await repository.mutateWorkspace((w) => {
          const run = w.runs[runId];
          if (!run) throw Error("Run not found");
          if(w.schemaVersion===3){assertScope(w,scope,clock.now());assertOwned(w,run,scope.packageId);}
          const event = {
            schemaVersion: 2,
            runId,
            seq: ++run.lastSeq,
            type,
            at: at(),
            payload: structuredClone(payload),
            ...(w.schemaVersion===3?{recordId:randomUUID(),ownerPackageId:scope.packageId}:{}),
          };
          run.events = [...(run.events || []), event].slice(-maxBuffered);
          return event;
        })
      ).result;
      for (const subscriber of listeners.get(runId) || [])
        subscriber.enqueue(event);
      return event;
    },
    async getSnapshot(runId,scope) {
      let w = await repository.read();
      if(w.schemaVersion===3){assertScope(w,scope,clock.now());assertOwned(w,w.runs[runId],scope.packageId);w=packageWorkspace(w,scope.packageId);}
      const
        run = w.runs[runId];
      if (!run) throw Error("Run not found");
      const ids = new Set(
          Object.values(w.observations)
            .filter((o) => o.runId === runId)
            .map((o) => o.jobId),
        ),
        evaluationIds = new Set(run.evaluationIds || []);
      return {
        schemaVersion: 2,
        runId,
        seq: run.lastSeq || 0,
        type: "snapshot",
        at: at(),
        payload: {
          run,
          jobs: resolveJobIds(w, [...ids], { allowMissing: true }).map(
            (jobId) => ({
              ...w.jobs[jobId],
              canonical: selectRunJobFact(w, { runId, jobId }).record,
            }),
          ),
          evaluations: Object.values(w.evaluations)
            .filter(
              (e) => evaluationIds.has(e.evaluationId) || e.runId === runId,
            )
            .map((e) => ({
              ...e,
              jobId:
                resolveJobId(w, e.jobId, { allowMissing: true }) || e.jobId,
              originalJobId: e.jobId,
            })),
        },
      };
    },
    async subscribe(runId, { afterSeq = 0, onEvent, onClose, signal,scope }) {
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
        lastSeq = afterSeq,
        queue = [],
        polling = false;
      const subscriber = {
        enqueue(event) {
          if (closed || (event.seq != null && event.seq <= lastSeq)) return;
          if (queue.length >= maxBuffered) queue = [{ type: "resync" }];
          else queue.push(event);
          if (ready) void pump();
        },
      };
      const unsubscribe = () => {
        if (closed) return;
        closed = true;
        queue = [];
        listeners.get(runId)?.delete(subscriber);
        clearInterval(poll);
        signal?.removeEventListener("abort", unsubscribe);
      };
      const closeAfterFailure = (error) => {
        if(closed)return;
        unsubscribe();
        try{onClose?.(error);}catch{}
      };
      async function pump() {
        if (pumping || closed) return;
        pumping = true;
        try {
          while (queue.length && !closed) {
            let event = queue.shift();
            const current=scope?await hub.getSnapshot(runId,scope):null;
            if (event.type === "resync") event = current||await hub.getSnapshot(runId,scope);
            if (event.seq <= lastSeq && event.type !== "snapshot") continue;
            if (event.type === "snapshot" && event.seq < lastSeq) continue;
            await onEvent(event);
            lastSeq = Math.max(lastSeq, event.seq);
          }
        } catch (error) {
          closeAfterFailure(error);
        } finally {
          pumping = false;
        }
      }
      if (!listeners.has(runId)) listeners.set(runId, new Set());
      listeners.get(runId).add(subscriber);
      let poll;
      try {
        const snapshot = await hub.getSnapshot(runId,scope),
          run = snapshot.payload.run;
        if (afterSeq > snapshot.seq) throw Error("Future event cursor seq");
        const events = run.events || [];
        const pending = queue;
        queue = [];
        if (
          !events.length ||
          (afterSeq === snapshot.seq &&
            [
              "completed",
              "partial",
              "failed",
              "cancelled",
              "interrupted",
            ].includes(run.status)) ||
          afterSeq < (events[0]?.seq || 1) - 1
        )
          queue.push(snapshot);
        else queue.push(...events.filter((e) => e.seq > afterSeq));
        queue.push(
          ...pending.filter((e) => e.type === "resync" || e.seq > snapshot.seq),
        );
        ready = true;
        // Reads also observe commits made by a different local entry process.
        poll = setInterval(async () => {
          if (closed || polling) return;
          polling = true;
          try {
            const current = await hub.getSnapshot(runId,scope);
            if (current.seq > lastSeq) {
              const events = current.payload.run.events || [];
              if (!events.length || lastSeq < events[0].seq - 1)
                subscriber.enqueue({ type: "resync" });
              else for (const event of events) subscriber.enqueue(event);
            }
          } catch (error) {
            closeAfterFailure(error);
          } finally {
            polling = false;
          }
        }, 1000);
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
