CREATE TABLE IF NOT EXISTS atmos_reading_rollups (
  device_id uuid NOT NULL REFERENCES atmos_devices(id),
  bucket_start timestamptz NOT NULL,
  sample_count integer NOT NULL CHECK (sample_count > 0),
  temperature_min double precision NOT NULL,
  temperature_avg double precision NOT NULL,
  temperature_max double precision NOT NULL,
  humidity_min double precision NOT NULL,
  humidity_avg double precision NOT NULL,
  humidity_max double precision NOT NULL,
  PRIMARY KEY (device_id, bucket_start)
);

CREATE INDEX IF NOT EXISTS atmos_readings_rollup_scan
  ON atmos_readings (measured_at, device_id);
