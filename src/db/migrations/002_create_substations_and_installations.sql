CREATE TABLE grid_substations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts (id),
  name text NOT NULL,
  CONSTRAINT grid_substations_name_not_blank CHECK (btrim(name) <> '')
);

CREATE INDEX grid_substations_district_id_idx ON grid_substations (district_id);

-- The meter is identified on the installation; there is no separate device table.
CREATE TABLE solar_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  substation_id uuid NOT NULL REFERENCES grid_substations (id),
  meter_id text NOT NULL,
  address text,
  capacity_kw numeric(10, 3) NOT NULL,
  CONSTRAINT solar_installations_meter_id_not_blank CHECK (btrim(meter_id) <> ''),
  CONSTRAINT solar_installations_address_not_blank CHECK (address IS NULL OR btrim(address) <> ''),
  -- numeric accepts 'NaN', which PostgreSQL sorts above every number, so exclude it explicitly.
  CONSTRAINT solar_installations_capacity_kw_positive CHECK (capacity_kw > 0 AND capacity_kw <> 'NaN')
);

-- Meter IDs are unique regardless of case, so 'MTR-001' and 'mtr-001' are the same meter.
CREATE UNIQUE INDEX solar_installations_meter_id_lower_key ON solar_installations (lower(meter_id));

CREATE INDEX solar_installations_substation_id_idx ON solar_installations (substation_id);
