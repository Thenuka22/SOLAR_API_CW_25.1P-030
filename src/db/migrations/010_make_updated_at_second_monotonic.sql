-- Last-Modified is an HTTP-date with whole-second precision. With set_updated_at() from
-- migration 009, two changes to one row in the same second got the same Last-Modified, so a
-- client holding the first version could get 304 for the second. Every change now moves
-- updated_at to a later whole second than the previous version's, so each version of a row has
-- its own Last-Modified second. Row locks order the versions, so this holds even when the
-- later change commits after a response built from the earlier one.
--
-- updated_at can therefore run up to a second or so ahead of the clock after rapid changes;
-- responses omit Last-Modified while it is later than the time of the query
-- (src/routes/provinces.js).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := clock_timestamp();
  ELSIF to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    NEW.updated_at := greatest(clock_timestamp(), date_trunc('second', OLD.updated_at) + interval '1 second');
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$;
