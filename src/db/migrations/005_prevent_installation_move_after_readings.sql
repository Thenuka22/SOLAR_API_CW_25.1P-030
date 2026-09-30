-- An installation that has generation readings cannot move to another substation,
-- because its history would then appear under a different substation and jurisdiction.

CREATE FUNCTION solar_installations_reject_move_with_readings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A reading insert only takes a KEY SHARE lock on its installation, which a
  -- substation_id update does not conflict with. Lock the row FOR UPDATE first so
  -- a concurrent first reading waits for this move (or this move waits for it),
  -- then check for readings.
  PERFORM 1 FROM solar_installations WHERE id = OLD.id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM generation_readings WHERE installation_id = OLD.id) THEN
    RAISE EXCEPTION 'installation % has generation readings and cannot move to another substation', OLD.id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER solar_installations_no_move_with_readings
  BEFORE UPDATE OF substation_id ON solar_installations
  FOR EACH ROW
  WHEN (NEW.substation_id IS DISTINCT FROM OLD.substation_id)
  EXECUTE FUNCTION solar_installations_reject_move_with_readings();
