-- Credential storage for staff users, installation devices, and provisioners.
-- See docs/authentication.md. Only scrypt hashes are stored, never the secrets themselves.

-- PHC string form: $scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash>, with base64 salt (16+ bytes)
-- and hash (32+ bytes) without padding. Anything else, including a plaintext secret, is rejected.
CREATE DOMAIN scrypt_hash AS text
  CONSTRAINT scrypt_hash_format CHECK (
    VALUE ~ '^\$scrypt\$ln=[0-9]{1,2},r=[0-9]{1,3},p=[0-9]{1,3}\$[A-Za-z0-9+/]{22,}\$[A-Za-z0-9+/]{43,}$'
  );

CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash scrypt_hash NOT NULL,
  changed_at timestamptz NOT NULL
);

CREATE TABLE device_credentials (
  installation_id uuid PRIMARY KEY REFERENCES solar_installations (id) ON DELETE CASCADE,
  secret_hash scrypt_hash NOT NULL,
  changed_at timestamptz NOT NULL
);

-- Provisioners are not SLSEA readers, so they are not rows in users.
CREATE TABLE provisioners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  password_hash scrypt_hash NOT NULL,
  changed_at timestamptz NOT NULL,
  CONSTRAINT provisioners_username_not_blank CHECK (btrim(username) <> '')
);

CREATE UNIQUE INDEX provisioners_username_normalized_key ON provisioners (lower(btrim(username)));

-- changed_at is the time the credential was created or its hash last changed. Tokens issued
-- before it are rejected, so it is set here and cannot be written directly.
-- TG_ARGV[0] names the hash column. clock_timestamp() records the time of the change itself,
-- not the start of the transaction.
CREATE FUNCTION credentials_set_changed_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR to_jsonb(NEW) ->> TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD) ->> TG_ARGV[0] THEN
    NEW.changed_at := clock_timestamp();
  ELSE
    NEW.changed_at := OLD.changed_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_credentials_set_changed_at
  BEFORE INSERT OR UPDATE ON user_credentials
  FOR EACH ROW EXECUTE FUNCTION credentials_set_changed_at('password_hash');

CREATE TRIGGER device_credentials_set_changed_at
  BEFORE INSERT OR UPDATE ON device_credentials
  FOR EACH ROW EXECUTE FUNCTION credentials_set_changed_at('secret_hash');

CREATE TRIGGER provisioners_set_changed_at
  BEFORE INSERT OR UPDATE ON provisioners
  FOR EACH ROW EXECUTE FUNCTION credentials_set_changed_at('password_hash');
