/** Format integer minor units (Stripe amounts) for display, e.g. 1900 USD -> "$19.00". */
export function formatMinorUnits(amount: number, currency = "usd"): string {
  const code = currency.toUpperCase();
  // Zero-decimal currencies (JPY, KRW, ...) report whole units in Stripe.
  const zeroDecimal = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
  const value = zeroDecimal.has(code) ? amount : amount / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

export function formatUsd(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
    minimumFractionDigits: Math.min(2, maximumFractionDigits),
  }).format(value);
}

/** Compact metric display for the LED band and billboards: 12,400 -> "12.4K". */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
