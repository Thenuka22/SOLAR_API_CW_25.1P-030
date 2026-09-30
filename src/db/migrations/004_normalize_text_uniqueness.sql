-- Compare names and meter IDs ignoring case and surrounding spaces, so values such as
-- 'Western', ' western' and 'WESTERN ' are treated as the same.

DROP INDEX provinces_name_lower_key;
CREATE UNIQUE INDEX provinces_name_normalized_key ON provinces (lower(btrim(name)));

DROP INDEX districts_province_id_name_lower_key;
-- Also serves as the index for looking up districts by province.
CREATE UNIQUE INDEX districts_province_id_name_normalized_key
  ON districts (province_id, lower(btrim(name)));

DROP INDEX solar_installations_meter_id_lower_key;
CREATE UNIQUE INDEX solar_installations_meter_id_normalized_key
  ON solar_installations (lower(btrim(meter_id)));
