CREATE TABLE provinces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  CONSTRAINT provinces_name_not_blank CHECK (btrim(name) <> '')
);

-- Names are unique regardless of case, so 'Western' and 'western' are the same province.
CREATE UNIQUE INDEX provinces_name_lower_key ON provinces (lower(name));

CREATE TABLE districts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  province_id uuid NOT NULL REFERENCES provinces (id),
  name text NOT NULL,
  CONSTRAINT districts_name_not_blank CHECK (btrim(name) <> '')
);

-- Case-insensitive name uniqueness within a province. Also serves as the index
-- for looking up districts by province.
CREATE UNIQUE INDEX districts_province_id_name_lower_key ON districts (province_id, lower(name));
