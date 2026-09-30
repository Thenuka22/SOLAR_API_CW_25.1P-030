-- Installation seed: 200 rooftop installations, meters MTR-0001 to MTR-0200.
-- Repeatable: a meter that already exists is left unchanged, so running it again adds nothing.
--
-- Installations are shared round-robin across the substations (ordered by province,
-- district, and name), so every substation gets 5 or 6. Capacities and addresses are
-- synthetic but plausible: mostly small residential systems, some commercial ones, and
-- every tenth installation has no address to exercise the optional field.
WITH substations AS (
  SELECT
    s.id,
    s.name,
    row_number() OVER (ORDER BY p.name, d.name, s.name) - 1 AS position,
    count(*) OVER () AS total
  FROM grid_substations s
  JOIN districts d ON d.id = s.district_id
  JOIN provinces p ON p.id = d.province_id
)
INSERT INTO solar_installations (substation_id, meter_id, address, capacity_kw)
SELECT
  s.id,
  'MTR-' || lpad(n::text, 4, '0'),
  CASE
    WHEN n % 10 = 0 THEN NULL
    ELSE format(
      'No. %s, %s, %s',
      (n * 13) % 250 + 1,
      (ARRAY['Main Street', 'Temple Road', 'Station Road', 'School Lane',
             'Lake Road', 'Hospital Road', 'Church Road', 'Market Street'])[n % 8 + 1],
      s.name
    )
  END,
  (ARRAY[3.3, 3.3, 4.4, 4.4, 5.5, 5.5, 5.5, 6.6, 6.6, 8.25,
         8.25, 10, 10, 12.1, 15, 20, 25, 40, 60, 100])[(n * 7) % 20 + 1]
FROM generate_series(1, 200) AS n
JOIN substations s ON s.position = (n - 1) % s.total
ON CONFLICT (lower(btrim(meter_id))) DO NOTHING;
