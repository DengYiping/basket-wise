/** Parse a displayed price without floating-point rounding or guessing currency. */
export function parsePrice(
  text: string,
  fractionDigits: number,
): number | undefined {
  if (
    !Number.isInteger(fractionDigits) ||
    fractionDigits < 0 ||
    fractionDigits > 4
  )
    return undefined;
  const match = /^(\d+)(?:[.,](\d*))?$/.exec(text.trim());
  if (!match || (match[2]?.length ?? 0) > fractionDigits) return undefined;
  const scale = 10 ** fractionDigits;
  const amount =
    Number(match[1]) * scale +
    Number((match[2] ?? "").padEnd(fractionDigits, "0"));
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= 1_000_000
    ? amount
    : undefined;
}
