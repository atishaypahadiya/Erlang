-- 50,000 countries, so loading the list takes time a first request would
-- wait for; the rest one row or a few. :scale is unused: L11 is judged on a
-- first request against later ones.
insert into countries (code, name, vat) select 'C' || i, 'Country ' || i, 0.2 from generate_series(1, 50000) i;
insert into holidays (day) values ('2026-12-25');
insert into delivery_days (region, days) values ('scotland', 3), ('wales', 2);
insert into invoices (total_cents) values (1000);
insert into fx (pair, rate) values ('GBPEUR', 1.17);
insert into products (price_pence) values (999);
insert into settings (name, value) values ('default_note', 'Thank you');
