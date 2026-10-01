-- Last modification time for installation metadata, used for Last-Modified on installation reads
-- and for If-Unmodified-Since on installation updates. Maintained by set_updated_at() as for
-- provinces. Readings are a separate table, so a new reading does not change it. Existing rows
-- get the time of this migration.
ALTER TABLE solar_installations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER solar_installations_set_updated_at
  BEFORE INSERT OR UPDATE ON solar_installations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
