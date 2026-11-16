-- +goose Up
-- +goose StatementBegin
DO $$
BEGIN
    IF current_setting('server_encoding') <> 'UTF8' THEN
        RAISE EXCEPTION 'Secret Server requires a UTF8 database';
    END IF;
END;
$$;
-- +goose StatementEnd

CREATE TABLE secret (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL,
    scope text NOT NULL CHECK (scope IN ('org', 'box')),
    box_id varchar(64),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    name_normalized text NOT NULL CHECK (name_normalized ~ '^[A-Z0-9_]{1,64}$'),
    ciphertext bytea NOT NULL,
    encrypted_dek bytea NOT NULL,
    key_id text NOT NULL CHECK (key_id <> '' AND length(key_id) <= 128),
    hosts text[] NOT NULL CHECK (cardinality(hosts) > 0),
    headers jsonb NOT NULL CHECK (jsonb_typeof(headers) = 'object' AND headers <> '{}'::jsonb),
    placeholder text NOT NULL CHECK (placeholder <> ''),
    disabled_at timestamptz,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((scope = 'box') = (box_id IS NOT NULL)),
    -- Keep this mapping consistent with database.NormalizeName.
    CHECK (name_normalized = translate(
        regexp_replace(name COLLATE "C", '[^A-Za-z0-9_]', '_', 'g'),
        'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'))
);
CREATE UNIQUE INDEX secret_org_name_uq ON secret (organization_id, name_normalized) WHERE scope = 'org';
CREATE UNIQUE INDEX secret_box_name_uq ON secret (box_id, name_normalized) WHERE scope = 'box';
CREATE INDEX secret_org_idx ON secret (organization_id);

CREATE INDEX secret_key_idx ON secret (key_id);

-- +goose StatementBegin
CREATE FUNCTION protect_secret_value() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- encrypted_dek and key_id remain mutable for future KMS rewrapping.
    IF (NEW.id, NEW.organization_id, NEW.scope, NEW.box_id, NEW.name, NEW.name_normalized, NEW.ciphertext, NEW.hosts, NEW.headers,
        NEW.placeholder, NEW.created_by, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.organization_id, OLD.scope, OLD.box_id, OLD.name, OLD.name_normalized, OLD.ciphertext, OLD.hosts, OLD.headers,
        OLD.placeholder, OLD.created_by, OLD.created_at) THEN
        RAISE EXCEPTION 'secret value is immutable';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER secret_value_immutable BEFORE UPDATE ON secret
    FOR EACH ROW EXECUTE FUNCTION protect_secret_value();

CREATE TABLE key_verification_canary (
    id smallint PRIMARY KEY CHECK (id = 1),
    ciphertext bytea NOT NULL,
    encrypted_dek bytea NOT NULL,
    key_id text NOT NULL CHECK (key_id <> '' AND length(key_id) <= 128)
);

CREATE TABLE secret_access_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    credential_id uuid,
    runner_id text,
    box_id varchar(64),
    secret_id uuid,
    result text NOT NULL CHECK (result IN
        ('ok', 'attestation_failed', 'credential_invalid', 'runner_mismatch',
         'not_found', 'disabled', 'decrypt_failed'))
);
CREATE INDEX secret_access_log_time_idx ON secret_access_log (occurred_at);
CREATE INDEX secret_access_log_secret_idx ON secret_access_log (secret_id, occurred_at);
CREATE INDEX secret_access_log_runner_idx ON secret_access_log (runner_id, occurred_at);
