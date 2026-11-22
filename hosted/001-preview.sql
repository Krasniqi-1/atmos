CREATE TABLE IF NOT EXISTS atmos_devices (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  key_hash text UNIQUE NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS atmos_readings (
  device_id uuid NOT NULL REFERENCES atmos_devices(id),
  reading_id text NOT NULL,
  measured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  temperature double precision NOT NULL CHECK (temperature BETWEEN -40 AND 80),
  humidity double precision NOT NULL CHECK (humidity BETWEEN 0 AND 100),
  PRIMARY KEY (device_id, reading_id)
);

CREATE INDEX IF NOT EXISTS atmos_readings_history
  ON atmos_readings (device_id, measured_at DESC, reading_id DESC);