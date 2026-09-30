-- Geography seed: 9 provinces, 25 districts, 35 grid substations.
-- Repeatable: existing rows are left unchanged, so running it again adds nothing.
--
-- Provinces and districts are Sri Lanka's administrative divisions. Substation names
-- come from the grid substation table (Table 3.1) of the CEB Long Term Transmission
-- Development Plan 2013-2022, with standard place-name spellings. Mullaitivu has no
-- substation in that plan; 'Mullaitivu' is a placeholder so every district has one.

INSERT INTO provinces (name)
VALUES
  ('Western'), ('Central'), ('Southern'), ('Northern'), ('Eastern'),
  ('North Western'), ('North Central'), ('Uva'), ('Sabaragamuwa')
ON CONFLICT (lower(btrim(name))) DO NOTHING;

INSERT INTO districts (province_id, name)
SELECT p.id, d.name
FROM (
  VALUES
    ('Western', 'Colombo'), ('Western', 'Gampaha'), ('Western', 'Kalutara'),
    ('Central', 'Kandy'), ('Central', 'Matale'), ('Central', 'Nuwara Eliya'),
    ('Southern', 'Galle'), ('Southern', 'Matara'), ('Southern', 'Hambantota'),
    ('Northern', 'Jaffna'), ('Northern', 'Kilinochchi'), ('Northern', 'Mannar'),
    ('Northern', 'Vavuniya'), ('Northern', 'Mullaitivu'),
    ('Eastern', 'Batticaloa'), ('Eastern', 'Ampara'), ('Eastern', 'Trincomalee'),
    ('North Western', 'Kurunegala'), ('North Western', 'Puttalam'),
    ('North Central', 'Anuradhapura'), ('North Central', 'Polonnaruwa'),
    ('Uva', 'Badulla'), ('Uva', 'Monaragala'),
    ('Sabaragamuwa', 'Ratnapura'), ('Sabaragamuwa', 'Kegalle')
) AS d (province, name)
JOIN provinces p ON lower(btrim(p.name)) = lower(d.province)
ON CONFLICT (province_id, lower(btrim(name))) DO NOTHING;

-- One substation per district, plus ten more in the busier districts.
-- Substation names are not unique in the schema, so skip any that already exist.
INSERT INTO grid_substations (district_id, name)
SELECT d.id, s.name
FROM (
  VALUES
    ('Western', 'Colombo', 'Kolonnawa'), ('Western', 'Colombo', 'Pannipitiya'),
    ('Western', 'Colombo', 'Dehiwala'), ('Western', 'Colombo', 'Sri Jayawardenepura'),
    ('Western', 'Gampaha', 'Biyagama'), ('Western', 'Gampaha', 'Kotugoda'),
    ('Western', 'Gampaha', 'Veyangoda'),
    ('Western', 'Kalutara', 'Horana'), ('Western', 'Kalutara', 'Panadura'),
    ('Central', 'Kandy', 'Pallekele'), ('Central', 'Kandy', 'Kiribathkumbura'),
    ('Central', 'Matale', 'Naula'),
    ('Central', 'Nuwara Eliya', 'Nuwara Eliya'),
    ('Southern', 'Galle', 'Galle'), ('Southern', 'Galle', 'Ambalangoda'),
    ('Southern', 'Matara', 'Matara'),
    ('Southern', 'Hambantota', 'Hambantota'),
    ('Northern', 'Jaffna', 'Chunnakam'),
    ('Northern', 'Kilinochchi', 'Kilinochchi'),
    ('Northern', 'Mannar', 'Mannar'),
    ('Northern', 'Vavuniya', 'Vavuniya'),
    ('Northern', 'Mullaitivu', 'Mullaitivu'),
    ('Eastern', 'Batticaloa', 'Valachchenai'),
    ('Eastern', 'Ampara', 'Ampara'),
    ('Eastern', 'Trincomalee', 'Trincomalee'),
    ('North Western', 'Kurunegala', 'Kurunegala'), ('North Western', 'Kurunegala', 'Pannala'),
    ('North Western', 'Puttalam', 'Puttalam'),
    ('North Central', 'Anuradhapura', 'Anuradhapura'), ('North Central', 'Anuradhapura', 'Habarana'),
    ('North Central', 'Polonnaruwa', 'Polonnaruwa'),
    ('Uva', 'Badulla', 'Badulla'),
    ('Uva', 'Monaragala', 'Monaragala'),
    ('Sabaragamuwa', 'Ratnapura', 'Ratnapura'),
    ('Sabaragamuwa', 'Kegalle', 'Kegalle')
) AS s (province, district, name)
JOIN provinces p ON lower(btrim(p.name)) = lower(s.province)
JOIN districts d ON d.province_id = p.id AND lower(btrim(d.name)) = lower(s.district)
WHERE NOT EXISTS (
  SELECT 1 FROM grid_substations g
  WHERE g.district_id = d.id AND lower(btrim(g.name)) = lower(s.name)
);
