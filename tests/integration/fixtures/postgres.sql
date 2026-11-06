CREATE EXTENSION pgcrypto;
CREATE SCHEMA extra;

CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  bio text
);
CREATE TABLE public.orders (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES public.customers (id),
  total numeric(10, 2) NOT NULL
);
CREATE TABLE public.audit (
  id serial PRIMARY KEY,
  note text NOT NULL
);
CREATE TABLE public.blobs (
  id integer PRIMARY KEY,
  data bytea NOT NULL
);
CREATE TABLE extra.items (
  id integer PRIMARY KEY,
  label text NOT NULL
);

CREATE SEQUENCE public.ticket_seq;

CREATE FUNCTION public.add_one(n integer) RETURNS integer
  LANGUAGE sql IMMUTABLE AS $$ SELECT n + 1 $$;

CREATE FUNCTION public.log_order() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.audit (note) VALUES ('order ' || NEW.id);
  RETURN NEW;
END
$$;
CREATE TRIGGER orders_audit AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.log_order();

CREATE VIEW public.order_totals AS
  SELECT c.name, sum(o.total) AS total
  FROM public.customers c JOIN public.orders o ON o.customer_id = c.id
  GROUP BY c.name;

INSERT INTO public.customers (name, bio) VALUES
  ('Ada', 'Hello 😀 wörld — ünïcode ✓'),
  ('Grace', 'Stored as DEFINER=`root`@`%` in a comment');
INSERT INTO public.orders (customer_id, total) VALUES (1, 10.50), (1, 4.25), (2, 99.99);

INSERT INTO public.blobs (id, data)
  SELECT 1, decode(string_agg(lpad(to_hex(i), 2, '0'), '' ORDER BY i), 'hex')
  FROM generate_series(0, 255) AS i;

INSERT INTO extra.items VALUES (1, 'one'), (2, 'two');

SELECT setval('public.ticket_seq', 41);
