import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import type { ApiError } from "../lib/types";
import { useEffect, useRef } from "react";
import { buildHash, parseRoute } from "../app/router";
export function FormFeedback({
  errors,
  error,
  onFocusField,
  includeServerErrors = true,
}: {
  errors?: Record<string, string>;
  error?: unknown;
  onFocusField?: (name: string) => void;
  includeServerErrors?: boolean;
}) {
  const e = error as ApiError | undefined;
  const fields = { ...(includeServerErrors ? e?.fieldErrors : {}), ...errors };
  const summary = useRef<HTMLDivElement>(null);
  const previous = useRef<{
    error: unknown;
    fields: Record<string, string>;
  } | null>(null);
  const errorKey = JSON.stringify(fields);
  useEffect(() => {
    const changed = Object.entries(fields).some(
      ([name, message]) => previous.current?.fields[name] !== message,
    );
    if ((error && error !== previous.current?.error) || changed)
      summary.current?.focus();
    previous.current = { error, fields };
  }, [error, errorKey]);
  if (!error && !Object.keys(fields ?? {}).length) return null;
  return (
    <Alert ref={summary} tabIndex={-1} variant="destructive" role="alert">
      <AlertTitle>
        {e?.message ?? "填写检查未通过，请修改标出的项目。"}
      </AlertTitle>
      <AlertDescription>
        {Object.keys(fields).length > 0 && (
          <ul>
            {Object.entries(fields).map(([name, message]) => (
              <li key={name}>
                <Button
                  type="button"
                  variant="link"
                  onClick={() =>
                    onFocusField
                      ? onFocusField(name)
                      : document.getElementById(name)?.focus()
                  }
                >
                  {message}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {e?.diagnosticId && (
          <a
            href={buildHash({
              page: "logs",
              selection: parseRoute(window.location.hash).selection,
              filters: { tab: "system", diagnosticId: e.diagnosticId },
            })}
          >
            查看错误诊断
          </a>
        )}
      </AlertDescription>
    </Alert>
  );
}
