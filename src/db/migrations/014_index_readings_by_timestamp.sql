-- Regional reading history (GET /readings) filters by time window across installations and
-- orders by timestamp, then ID. The (installation_id, timestamp) index only serves one
-- installation at a time; this one serves the time window and the order for any number.
CREATE INDEX generation_readings_timestamp_id_idx ON generation_readings ("timestamp", id);
