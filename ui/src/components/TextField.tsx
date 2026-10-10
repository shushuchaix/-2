import { Field, FieldLabel, FieldDescription, FieldError } from "./ui/field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import type { ComponentProps } from "react";
export type TextFieldProps = Omit<ComponentProps<"input">, "onChange"> & {
  name: string;
  label: string;
  onChange: (value: string) => void;
  error?: string;
  description?: string;
  multiline?: boolean;
};
export function TextField({
  name,
  label,
  onChange,
  error,
  description,
  multiline,
  ...props
}: TextFieldProps) {
  const attrs = {
    ...props,
    id: props.id ?? name,
    name,
    "aria-invalid": !!error,
    "aria-describedby": error
      ? name + "-error"
      : description
        ? name + "-description"
        : undefined,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={attrs.id}>{label}</FieldLabel>
      {multiline ? (
        <Textarea {...(attrs as ComponentProps<typeof Textarea>)} />
      ) : (
        <Input {...attrs} />
      )}{" "}
      {description && (
        <FieldDescription id={name + "-description"}>
          {description}
        </FieldDescription>
      )}
      {error && (
        <FieldError role="note" id={name + "-error"}>
          {error}
        </FieldError>
      )}
    </Field>
  );
}
