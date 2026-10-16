import { Alert, AlertDescription } from "./ui/alert";
import { Spinner } from "./ui/spinner";
import { FormFeedback } from "./FormFeedback";
export function OperationFeedback({
  result,
  busy,
  busyLabel = "正在处理，请稍候…",
  error,
}: {
  result?: string;
  busy?: boolean;
  busyLabel?: string;
  error?: unknown;
}) {
  return (
    <>
      {busy && (
        <p role="status" className="flex items-center gap-2">
          <Spinner aria-hidden="true" role="presentation" />
          {busyLabel}
        </p>
      )}
      {!busy && result && (
        <Alert role="status">
          <AlertDescription>{result}</AlertDescription>
        </Alert>
      )}
      <FormFeedback error={error} />
    </>
  );
}
