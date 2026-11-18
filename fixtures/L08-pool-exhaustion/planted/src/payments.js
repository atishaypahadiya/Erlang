const PAYMENTS = process.env.PAYMENTS_URL ?? 'http://payments.internal';

// Charges a card at the payment service.
export async function chargeCard(orderId, amount) {
  const res = await fetch(`${PAYMENTS}/charges`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId, amount }), signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`payments replied ${res.status}`);
  return res.json();
}

// Refunds a charge at the payment service.
export async function refundCharge(chargeId) {
  const res = await fetch(`${PAYMENTS}/charges/${chargeId}/refund`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`payments replied ${res.status}`);
  return res.json();
}

// Checks an order's fields. No I/O.
export async function validateOrder(order) {
  if (!Array.isArray(order.items) || !order.items.length) throw new Error('an order needs items');
  return order;
}
