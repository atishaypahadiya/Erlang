import { pool, withTransaction } from '../db.js';
import { chargeCard, refundCharge, validateOrder } from '../payments.js';
import { warehouse } from '../warehouse.js';

export default async function orders(app) {
  // GET /orders/:id: one order.
  app.get('/orders/:id', async function getOrder(request) {
    return (await pool.query('select id, total, paid_at from orders where id = $1', [request.params.id])).rows[0] ?? null;
  });

  // POST /orders: a new order and its items, in one transaction.
  app.post('/orders', async function createOrder(request) {
    return withTransaction(async (client) => {
      const { rows } = await client.query('insert into orders (total) values ($1) returning id', [request.body.total]);
      await client.query('insert into line_items (order_id, sku, quantity) select $1, * from unnest($2::text[], $3::int[])', [rows[0].id, request.body.items.map((i) => i.sku), request.body.items.map((i) => i.quantity)]);
      return rows[0];
    });
  });

  // POST /orders/:id/pay: charge the card, then mark the order paid.
  app.post('/orders/:id/pay', async function payOrder(request) {
    let client;
    try {
      client = await pool.connect();
      const charge = await chargeCard(request.params.id, request.body.amount);
      await client.query('update orders set paid_at = now(), charge_id = $2 where id = $1', [request.params.id, charge.id]);
      return { paid: true };
    } finally {
      client?.release();
    }
  });

  // POST /orders/:id/ship: reserve stock at the warehouse and record the shipment.
  app.post('/orders/:id/ship', async function shipOrder(request) {
    const client = await pool.connect();
    try {
      const { data } = await warehouse.post('/reservations', { orderId: request.params.id });
      await client.query('begin');
      await client.query('insert into shipments (order_id, reservation_id) values ($1, $2)', [request.params.id, data.id]);
      await client.query('update orders set shipped_at = now() where id = $1', [request.params.id]);
      await client.query('commit');
      return { reservation: data.id };
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  });

  // POST /orders/:id/refund: refund at the payment service first, then record it.
  app.post('/orders/:id/refund', async function refundOrder(request) {
    const refund = await refundCharge(request.body.chargeId);
    const client = await pool.connect();
    try {
      await client.query('insert into refunds (order_id, refund_id) values ($1, $2)', [request.params.id, refund.id]);
      return { refunded: true };
    } finally {
      client.release();
    }
  });

  // PUT /orders/:id: replace an order's items, after checking them.
  app.put('/orders/:id', async function replaceOrder(request) {
    const client = await pool.connect();
    try {
      const order = await validateOrder(request.body);
      await client.query('delete from line_items where order_id = $1', [request.params.id]);
      await client.query('insert into line_items (order_id, sku, quantity) select $1, * from unnest($2::text[], $3::int[])', [request.params.id, order.items.map((i) => i.sku), order.items.map((i) => i.quantity)]);
      return { replaced: true };
    } finally {
      client.release();
    }
  });
}
