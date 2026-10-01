-- Demo staff users: one reader for each role, so every jurisdiction rule can be exercised.
--   national   -> all data
--   provincial -> Western province
--   district   -> Colombo district
-- Users only: no passwords or hashes are stored here. A user cannot sign in until a password
-- is set with `npm run credentials -- staff-password <email>`; credentials are kept outside
-- the repository.
--
-- Repeatable: existing rows are left unchanged. If one of these email addresses already
-- belongs to a user with a different role or jurisdiction the seed stops with an error instead
-- of skipping it, so a demo password can never end up on an account with another scope.

CREATE TEMPORARY TABLE demo_users ON COMMIT DROP AS
SELECT u.name, u.email, u.role, p.id AS province_id, d.id AS district_id
FROM (
  VALUES
    ('Demo National Reader', 'national.reader@slsea.example', 'national', NULL, NULL),
    ('Demo Western Province Reader', 'western.reader@slsea.example', 'provincial', 'Western', NULL),
    ('Demo Colombo District Reader', 'colombo.reader@slsea.example', 'district', NULL, 'Colombo')
) AS u (name, email, role, province, district)
LEFT JOIN provinces p ON lower(btrim(p.name)) = lower(u.province)
LEFT JOIN districts d ON lower(btrim(d.name)) = lower(u.district);

DO $$
DECLARE
  conflicting text;
BEGIN
  SELECT string_agg(existing.email, ', ') INTO conflicting
  FROM demo_users demo
  JOIN users existing ON lower(existing.email) = lower(demo.email)
  WHERE existing.role <> demo.role
     OR existing.province_id IS DISTINCT FROM demo.province_id
     OR existing.district_id IS DISTINCT FROM demo.district_id;
  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION 'demo user seed: % already exists with a different role or jurisdiction', conflicting;
  END IF;
END
$$;

INSERT INTO users (name, email, role, province_id, district_id)
SELECT name, email, role, province_id, district_id FROM demo_users
ON CONFLICT (lower(email)) DO NOTHING;
