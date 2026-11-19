// A stand-in for a large PDF library: what matters here is when it loads.
export function render(invoice) {
  return Buffer.from(`%PDF-1.4\n% invoice ${invoice?.id ?? ''}, ${invoice?.total_cents ?? 0} cents\n%%EOF\n`);
}
