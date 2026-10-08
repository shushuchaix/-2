export function createStore(initial = {}) {
  let state = {
    selectedTargetId: null,
    targetRevisionId: null,
    route: "/workbench",
    jobs: { items: [], total: 0 },
    jobsRequestId: 0,
    run: null,
    ...initial,
  };
  const listeners = new Set();
  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispatch(action) {
      if (action.type === "target")
        state = {
          ...state,
          selectedTargetId: action.id,
          targetRevisionId: action.revisionId || null,
          run: null,
          jobs: { items: [], total: 0 },
          jobsRequestId: state.jobsRequestId + 1,
        };
      else if (action.type === "jobs-invalidated")
        state = {
          ...state,
          jobs: { items: [], total: 0 },
          jobsRequestId: state.jobsRequestId + 1,
          selectedJobId: null,
        };
      else if (action.type === "job-resolved") {
        const items = state.jobs.items.map((i) =>
          i.jobId === action.requestedJobId ? { ...i, jobId: action.jobId } : i,
        );
        state = {
          ...state,
          jobs: {
            ...state.jobs,
            items: [...new Map(items.map((i) => [i.jobId, i])).values()],
          },
          selectedJobId: action.jobId,
        };
      } else if (action.type === "versionUpdated")
        state = {
          ...state,
          versions: {
            ...state.versions,
            [action.version.revisionId]: action.version,
          },
        };
      else if (action.type === "route")
        state = { ...state, route: action.route };
      else if (action.type === "jobs-request")
        state = { ...state, jobsRequestId: action.requestId };
      else if (action.type === "jobs") {
        if (
          action.targetId !== state.selectedTargetId ||
          (action.targetRevisionId !== undefined &&
            action.targetRevisionId !== state.targetRevisionId) ||
          action.requestId !== state.jobsRequestId
        )
          return;
        state = { ...state, jobs: action.data };
      } else if (action.type === "run-start")
        state = {
          ...state,
          run: {
            runId: action.runId,
            lastSeq: 0,
            status: "queued",
            counts: {},
          },
        };
      else if (action.type === "run-event") {
        const e = action.event;
        if (
          !state.run ||
          e.runId !== state.run.runId ||
          e.seq <= state.run.lastSeq
        )
          return;
        state = {
          ...state,
          run: {
            ...state.run,
            ...(e.type === "snapshot" ? e.payload.run : e.payload),
            lastSeq: e.seq,
          },
        };
      } else return;
      for (const fn of listeners) fn(state);
    },
  };
}
