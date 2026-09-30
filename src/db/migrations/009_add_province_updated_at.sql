-- Last modification time for provinces, used for the Last-Modified header on province reads.
-- Set by the database on insert and whenever another column changes; it cannot be written
-- directly. Existing rows get the time of this migration.
ALTER TABLE provinces ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Reusable for other tables that gain updated_at. clock_timestamp() records the time of the
-- change itself, not the start of the transaction.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    NEW.updated_at := clock_timestamp();
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER provinces_set_updated_at
  BEFORE INSERT OR UPDATE ON provinces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
