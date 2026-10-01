// SQL expressions that build the JSON representation of a row, so a resource looks the same in
// its own endpoint and when embedded in another (the installation overview). Each expects the
// table alias named in its comment. numeric columns become JSON numbers.

// Province, alias p.
const PROVINCE_JSON = `json_build_object('id', p.id, 'name', p.name)`;

// District, alias d.
const DISTRICT_JSON = `json_build_object('id', d.id, 'provinceId', d.province_id, 'name', d.name)`;

// Grid substation, alias s.
const SUBSTATION_JSON = `json_build_object('id', s.id, 'districtId', s.district_id, 'name', s.name)`;

// Installation metadata, alias i. Readings are never included.
const INSTALLATION_JSON = `json_build_object(
  'id', i.id, 'substationId', i.substation_id, 'meterId', i.meter_id,
  'address', i.address, 'capacityKw', i.capacity_kw)`;

// Reading, alias r. The timestamp is returned in UTC with milliseconds.
const READING_JSON = `json_build_object(
  'id', r.id, 'installationId', r.installation_id,
  'timestamp', to_char(r."timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'powerKw', r.power_kw, 'energyKwh', r.energy_kwh, 'voltage', r.voltage)`;

module.exports = { PROVINCE_JSON, DISTRICT_JSON, SUBSTATION_JSON, INSTALLATION_JSON, READING_JSON };
