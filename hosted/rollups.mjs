export async function refreshRollups(sql, start, end) {
  return sql`
    INSERT INTO atmos_reading_rollups (
      device_id, bucket_start, sample_count, temperature_min, temperature_avg, temperature_max,
      humidity_min, humidity_avg, humidity_max
    )
    SELECT device_id, date_bin('5 minutes', measured_at, TIMESTAMPTZ '2000-01-01 00:00:00+00'),
      count(*)::integer, min(temperature), avg(temperature), max(temperature),
      min(humidity), avg(humidity), max(humidity)
    FROM atmos_readings
    WHERE measured_at >= ${start}::timestamptz AND measured_at < ${end}::timestamptz
    GROUP BY 1, 2
    ON CONFLICT (device_id, bucket_start) DO UPDATE SET
      sample_count = EXCLUDED.sample_count,
      temperature_min = EXCLUDED.temperature_min,
      temperature_avg = EXCLUDED.temperature_avg,
      temperature_max = EXCLUDED.temperature_max,
      humidity_min = EXCLUDED.humidity_min,
      humidity_avg = EXCLUDED.humidity_avg,
      humidity_max = EXCLUDED.humidity_max
    RETURNING device_id, bucket_start`;
}
