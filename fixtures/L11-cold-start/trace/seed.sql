-- 75,000 countries, so loading the list takes time a first request would
-- wait for; the rest one row or a few. 75,000, not 50,000 (the owner, 20
-- November 2026): at 50,000 the planted first request under load sat at 1.13
-- times its margin in milliseconds on CI (median 181 ms against 160); 75,000
-- is the smallest count estimated at 1.5 times or more with the planted twin
-- failing no request (fixtures/PLAN.md). At 100,000 it fell over on CI. :scale is unused: L11 is judged on a
-- first request against later ones.
insert into countries (code, name, vat) select 'C' || i, 'Country ' || i, 0.2 from generate_series(1, 75000) i;
insert into holidays (day) values ('2026-12-25');
insert into delivery_days (region, days) values ('scotland', 3), ('wales', 2);
insert into invoices (total_cents) values (1000);
insert into fx (pair, rate) values ('GBPEUR', 1.17);
insert into products (price_pence) values (999);
insert into settings (name, value) values ('default_note', 'Thank you');
