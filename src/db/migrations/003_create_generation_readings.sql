-- Append-only time series: a reading is inserted once and never updated or deleted.
CREATE TABLE generation_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL REFERENCES solar_installations (id),
  "timestamp" timestamptz NOT NULL,
  power_kw numeric(10, 3) NOT NULL,
  energy_kwh numeric(14, 3) NOT NULL,
  voltage numeric(7, 2) NOT NULL,
  -- numeric accepts 'NaN', which PostgreSQL sorts above every number, so exclude it explicitly.
  CONSTRAINT generation_readings_power_kw_non_negative CHECK (power_kw >= 0 AND power_kw <> 'NaN'),
  CONSTRAINT generation_readings_energy_kwh_non_negative CHECK (energy_kwh >= 0 AND energy_kwh <> 'NaN'),
  CONSTRAINT generation_readings_voltage_non_negative CHECK (voltage >= 0 AND voltage <> 'NaN')
);

-- One reading per installation per instant. Newest-first order also serves the
-- latest-reading and history queries, and covers lookups by installation.
CREATE UNIQUE INDEX generation_readings_installation_id_timestamp_key
  ON generation_readings (installation_id, "timestamp" DESC);

CREATE FUNCTION generation_readings_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'generation_readings is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER generation_readings_no_update_delete
  BEFORE UPDATE OR DELETE ON generation_readings
  FOR EACH ROW EXECUTE FUNCTION generation_readings_reject_change();

-- TRUNCATE skips row-level triggers, so block it with a statement-level trigger.
CREATE TRIGGER generation_readings_no_truncate
  BEFORE TRUNCATE ON generation_readings
  FOR EACH STATEMENT EXECUTE FUNCTION generation_readings_reject_change();
