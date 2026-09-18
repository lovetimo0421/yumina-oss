/**
 * Recipe R4: validation lives next to the field, never in a pill.
 * Give the input aria-describedby={id} so screen readers connect them.
 */
export function FieldError({ message, id }: { message?: string | null; id?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-[12px] leading-relaxed text-destructive/85">
      {message}
    </p>
  );
}
