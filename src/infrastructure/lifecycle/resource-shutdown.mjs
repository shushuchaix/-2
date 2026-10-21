/** One owner drains resources in order. A rejected close never skips later resources. */
export function createResourceShutdown({ resources, onError } = {}) {
  let promise,
    complete = false;
  return {
    get complete() {
      return complete;
    },
    close() {
      return (promise ||= Promise.resolve().then(async () => {
        const failedResources = [];
        try {
          for (const resource of resources()) {
            try {
              await resource.stop();
            } catch (error) {
              failedResources.push(resource.id);
              try {
                await onError?.(resource.id, error);
              } catch {
                /* Diagnostics cannot prevent closing. */
              }
            }
          }
          return { failedResources };
        } finally {
          complete = true;
        }
      }));
    },
  };
}
