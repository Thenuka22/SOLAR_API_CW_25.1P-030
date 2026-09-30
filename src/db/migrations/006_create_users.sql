-- SLSEA staff who read data. A user's role sets their read scope:
--   national   -> no province, no district (all data)
--   provincial -> one province, no district
--   district   -> one district, no province (the province is derived through the district)
-- Credentials are added with authentication, not here.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL,
  province_id uuid REFERENCES provinces (id),
  district_id uuid REFERENCES districts (id),
  CONSTRAINT users_name_not_blank CHECK (btrim(name) <> ''),
  -- A basic shape check (one @, no whitespace); full validation belongs in the API.
  CONSTRAINT users_email_format CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  CONSTRAINT users_role_valid CHECK (role IN ('national', 'provincial', 'district')),
  CONSTRAINT users_scope_matches_role CHECK (
    (role = 'national' AND province_id IS NULL AND district_id IS NULL)
    OR (role = 'provincial' AND province_id IS NOT NULL AND district_id IS NULL)
    OR (role = 'district' AND province_id IS NULL AND district_id IS NOT NULL)
  )
);

-- Email addresses are unique regardless of case. Whitespace is already rejected above.
CREATE UNIQUE INDEX users_email_normalized_key ON users (lower(email));

-- Support scope lookups and the foreign key checks when a province or district is deleted.
CREATE INDEX users_province_id_idx ON users (province_id) WHERE province_id IS NOT NULL;
CREATE INDEX users_district_id_idx ON users (district_id) WHERE district_id IS NOT NULL;
