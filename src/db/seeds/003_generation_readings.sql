-- Reading seed: one week of 15-minute readings for the 200 seeded installations.
-- Window: 2026-09-01 00:00 to 2026-09-08 00:00 Sri Lanka time (+05:30), start inclusive
-- and end exclusive, so 7 x 96 = 672 readings per installation and 134,400 in total.
-- Repeatable: a reading that already exists is left unchanged, so running it again adds nothing.
--
-- Values are synthetic but deterministic. Every "random" number is taken from an md5 hash
-- of the meter ID, district, date or slot, so each run and each database gets the same
-- readings. Meter IDs are used rather than row UUIDs because the UUIDs differ per database.
--
-- Power follows a daylight curve between about 06:05 and 18:10 local time and is 0 at
-- night. A weather factor per district and day makes some days cloudier, and a smaller
-- factor per reading adds passing cloud. Energy is a cumulative meter that starts from
-- an earlier lifetime total and adds power x 0.25 h each slot, so it never decreases.
-- Voltage stays near 230 V and rises slightly with generation.
WITH installations AS (
  SELECT
    i.id,
    m.meter,
    i.capacity_kw::float8 AS capacity_kw,
    d.name AS district
  FROM generate_series(1, 200) AS n
  CROSS JOIN LATERAL (SELECT 'MTR-' || lpad(n::text, 4, '0') AS meter) AS m
  JOIN solar_installations i ON lower(btrim(i.meter_id)) = lower(m.meter)
  JOIN grid_substations s ON s.id = i.substation_id
  JOIN districts d ON d.id = s.district_id
),
slots AS (
  SELECT
    ts,
    to_char(ts AT TIME ZONE 'Asia/Colombo', 'YYYY-MM-DD') AS local_date,
    extract(epoch FROM ts)::bigint AS epoch,
    -- Position of the slot between sunrise (06:05) and sunset (18:10), from 0 to 1.
    (extract(epoch FROM (ts AT TIME ZONE 'Asia/Colombo')::time) / 3600 - 6.083) / 12.083 AS day_position
  FROM generate_series(
    timestamptz '2026-09-01 00:00+05:30',
    timestamptz '2026-09-08 00:00+05:30' - interval '15 minutes',
    interval '15 minutes'
  ) AS ts
),
samples AS (
  SELECT
    i.id,
    i.meter,
    i.capacity_kw,
    sl.ts,
    CASE
      WHEN sl.day_position > 0 AND sl.day_position < 1 THEN power(sin(pi() * sl.day_position), 1.3)
      ELSE 0
    END AS sun,
    -- Deterministic numbers in [0, 1): the first 32 bits of an md5 hash. The keys use
    -- text that does not depend on session settings (epoch seconds, YYYY-MM-DD dates).
    ('x' || substr(md5('site:' || i.meter), 1, 8))::bit(32)::bigint / 4294967296.0 AS site_u,
    ('x' || substr(md5('day:' || i.district || ':' || sl.local_date), 1, 8))::bit(32)::bigint / 4294967296.0 AS day_u,
    ('x' || substr(md5('cloud:' || i.meter || ':' || sl.epoch), 1, 8))::bit(32)::bigint / 4294967296.0 AS cloud_u,
    ('x' || substr(md5('volt:' || i.meter || ':' || sl.epoch), 1, 8))::bit(32)::bigint / 4294967296.0 AS volt_u,
    ('x' || substr(md5('base:' || i.meter), 1, 8))::bit(32)::bigint / 4294967296.0 AS base_u
  FROM installations i
  CROSS JOIN slots sl
),
readings AS (
  SELECT
    id,
    ts,
    base_u,
    capacity_kw,
    volt_u,
    -- 80% of rated capacity at best; orientation 85-100%; weather 55-100%; passing cloud 80-100%.
    round((capacity_kw * 0.8 * (0.85 + 0.15 * site_u) * (0.55 + 0.45 * day_u) * (0.8 + 0.2 * cloud_u) * sun)::numeric, 3) AS power_kw,
    sun
  FROM samples
)
INSERT INTO generation_readings (installation_id, "timestamp", power_kw, energy_kwh, voltage)
SELECT
  id,
  ts,
  power_kw,
  -- Lifetime total before the window (about 400-1200 days at 4 kWh per kW per day),
  -- plus the energy generated in this window up to and including this slot.
  round(
    (capacity_kw * 4 * (400 + 800 * base_u))::numeric
      + sum(power_kw * 0.25) OVER (PARTITION BY id ORDER BY ts ROWS UNBOUNDED PRECEDING),
    3
  ),
  round((228 + 6 * volt_u + 4 * sun)::numeric, 2)
FROM readings
ON CONFLICT (installation_id, "timestamp") DO NOTHING;
