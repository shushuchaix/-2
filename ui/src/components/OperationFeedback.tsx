import { Alert, AlertDescription } from "./ui/alert";
import { Spinner } from "./ui/spinner";
import { FormFeedback } from "./FormFeedback";
export function OperationFeedback({
  result,
  busy,
  error,
}: {
  result?: string;
  busy?: boolean;
  error?: unknown;
}) {
  return (
    <>
      {busy && (
        <p role="status" className="flex items-center gap-2">
          <Spinner />
          正在处理，请稍候…
        </p>
      )}
      {result && (
        <Alert role="status">
          <AlertDescription>{result}</AlertDescription>
        </Alert>
      )}
      <FormFeedback error={error} />
    </>
  );
}
