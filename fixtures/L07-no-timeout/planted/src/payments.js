// Charges and refunds through the payments service.
const BASE = process.env.PAYMENTS_URL;

export async function charge(order) {
  const res = await fetch(`${BASE}/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: order.total, currency: order.currency }),
  });
  return res.json();
}

export async function refund(payment, req) {
  const res = await fetch(`${BASE}/refunds`, {
    method: 'POST',
    signal: AbortSignal.any([req.signal, AbortSignal.timeout(5000)]),
    body: JSON.stringify({ payment: payment.id }),
  });
  return res.json();
}
