-- Last modification time for grid substations, used for the Last-Modified header on substation
-- reads. Maintained by set_updated_at() as for provinces and districts. Existing rows get the
-- time of this migration.
ALTER TABLE grid_substations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER grid_substations_set_updated_at
  BEFORE INSERT OR UPDATE ON grid_substations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
