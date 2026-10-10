import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import type { ApiError } from "../lib/types";
import { useEffect, useRef } from "react";
import { buildHash, parseRoute } from "../app/router";
export function FormFeedback({
  errors,
  error,
  onFocusField,
}: {
  errors?: Record<string, string>;
  error?: unknown;
  onFocusField?: (name: string) => void;
}) {
  const e = error as ApiError | undefined;
  const fields = { ...e?.fieldErrors, ...errors };
  const summary = useRef<HTMLDivElement>(null);
  const errorKey = JSON.stringify(fields);
  useEffect(() => {
    if (error || Object.keys(fields).length) summary.current?.focus();
  }, [error, errorKey]);
  if (!error && !Object.keys(fields ?? {}).length) return null;
  return (
    <Alert ref={summary} tabIndex={-1} variant="destructive" role="alert">
      <AlertTitle>
        {e?.message ?? "填写检查未通过，请修改标出的项目。"}
      </AlertTitle>
      <AlertDescription>
        {fields && (
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
