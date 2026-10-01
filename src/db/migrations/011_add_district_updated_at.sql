-- Last modification time for districts, used for the Last-Modified header on district reads.
-- set_updated_at() (migrations 009 and 010) sets it on insert and moves it to a later whole
-- second on every change, so it cannot be written directly. Existing rows get the time of this
-- migration.
ALTER TABLE districts ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER districts_set_updated_at
  BEFORE INSERT OR UPDATE ON districts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
