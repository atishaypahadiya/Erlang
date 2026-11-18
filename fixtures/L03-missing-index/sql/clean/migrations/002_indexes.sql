create index events_user_id_created_at_idx on events (user_id, created_at);
create index order_items_order_id_idx on order_items (order_id);
create index orders_created_at_idx on orders (created_at);
create index audit_log_actor_id_idx on audit_log (actor_id);
