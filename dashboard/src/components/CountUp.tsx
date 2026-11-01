/** Render current measurements immediately, including in background tabs. */
export function CountUp({ value, format }: {
  value: number;
  format: (value: number) => string;
  duration?: number;
}) {
  return <span>{format(value)}</span>;
}
