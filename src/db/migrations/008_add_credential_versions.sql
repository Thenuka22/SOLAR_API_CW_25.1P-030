-- Token revocation by credential version instead of by time.
-- JWT `iat` has whole-second precision, so an `iat < changed_at` check can leave a token issued
-- earlier in the same second as a password change still valid. Each credential now has a random
-- version that changes whenever its hash changes; tokens carry it and must match the stored
-- value. changed_at is kept for auditing.

-- The volatile default gives every existing row its own random version.
ALTER TABLE user_credentials ADD COLUMN credential_version uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE device_credentials ADD COLUMN credential_version uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE provisioners ADD COLUMN credential_version uuid NOT NULL DEFAULT gen_random_uuid();

-- From now on the trigger sets it.
ALTER TABLE user_credentials ALTER COLUMN credential_version DROP DEFAULT;
ALTER TABLE device_credentials ALTER COLUMN credential_version DROP DEFAULT;
ALTER TABLE provisioners ALTER COLUMN credential_version DROP DEFAULT;

-- Sets changed_at and a new credential_version when a credential is created or its hash
-- changes; otherwise keeps both, so neither can be written directly. TG_ARGV[0] names the
-- hash column.
CREATE FUNCTION credentials_track_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR to_jsonb(NEW) ->> TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD) ->> TG_ARGV[0] THEN
    NEW.changed_at := clock_timestamp();
    NEW.credential_version := gen_random_uuid();
  ELSE
    NEW.changed_at := OLD.changed_at;
    NEW.credential_version := OLD.credential_version;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER user_credentials_set_changed_at ON user_credentials;
DROP TRIGGER device_credentials_set_changed_at ON device_credentials;
DROP TRIGGER provisioners_set_changed_at ON provisioners;
DROP FUNCTION credentials_set_changed_at();

CREATE TRIGGER user_credentials_track_changes
  BEFORE INSERT OR UPDATE ON user_credentials
  FOR EACH ROW EXECUTE FUNCTION credentials_track_changes('password_hash');

CREATE TRIGGER device_credentials_track_changes
  BEFORE INSERT OR UPDATE ON device_credentials
  FOR EACH ROW EXECUTE FUNCTION credentials_track_changes('secret_hash');

CREATE TRIGGER provisioners_track_changes
  BEFORE INSERT OR UPDATE ON provisioners
  FOR EACH ROW EXECUTE FUNCTION credentials_track_changes('password_hash');
