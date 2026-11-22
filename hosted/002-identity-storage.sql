CREATE TABLE IF NOT EXISTS atmos_workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL
);

INSERT INTO atmos_workspaces (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'Atmos Preview')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS atmos_memberships (
  workspace_id uuid NOT NULL REFERENCES atmos_workspaces(id),
  issuer text NOT NULL,
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'viewer')),
  PRIMARY KEY (workspace_id, issuer, subject)
);

ALTER TABLE atmos_devices
  ADD COLUMN IF NOT EXISTS workspace_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'
    REFERENCES atmos_workspaces(id),
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'simulator' CHECK (source IN ('simulator', 'physical')),
  ADD COLUMN IF NOT EXISTS room text,
  ADD COLUMN IF NOT EXISTS expected_interval_seconds integer NOT NULL DEFAULT 6 CHECK (expected_interval_seconds > 0),
  ADD COLUMN IF NOT EXISTS last_contact_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ALTER COLUMN key_hash DROP NOT NULL;

CREATE INDEX IF NOT EXISTS atmos_devices_workspace ON atmos_devices (workspace_id, id);

CREATE TABLE IF NOT EXISTS atmos_device_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES atmos_devices(id),
  key_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

INSERT INTO atmos_device_keys (device_id, key_hash, created_at)
SELECT id, key_hash, registered_at FROM atmos_devices WHERE key_hash IS NOT NULL
ON CONFLICT (key_hash) DO NOTHING;

CREATE INDEX IF NOT EXISTS atmos_device_keys_device ON atmos_device_keys (device_id, id);

ALTER TABLE atmos_readings
  ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'simulator'
    CHECK (provenance IN ('simulator', 'physical')),
  ADD COLUMN IF NOT EXISTS time_basis text NOT NULL DEFAULT 'estimated_from_age'
    CHECK (time_basis IN ('estimated_from_age', 'device_clock'));

CREATE TABLE IF NOT EXISTS atmos_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES atmos_workspaces(id),
  device_id uuid NOT NULL REFERENCES atmos_devices(id),
  key_id uuid REFERENCES atmos_device_keys(id),
  actor text NOT NULL,
  action text NOT NULL CHECK (action IN ('register', 'issue_key', 'revoke_key', 'rename', 'disable')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
