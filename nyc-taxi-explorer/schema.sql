-- NYC Taxi Explorer — Database Schema
-- SQLite (managed via better-sqlite3)
-- Normalised relational schema — generated automatically on first run by server.js
-- Schema version: 2.0

PRAGMA journal_mode   = WAL;
PRAGMA synchronous    = NORMAL;
PRAGMA cache_size     = -131072;   -- ~128 MB page cache
PRAGMA temp_store     = MEMORY;
PRAGMA mmap_size      = 536870912; -- 512 MB memory-mapped I/O
PRAGMA page_size      = 65536;     -- 64 KB pages (set before first write only)

-- ── Dimension: vendors ──────────────────────────────────────────────────────
-- Stores the two known NYC taxi technology vendors.
-- Trips reference this via vendor_id FK, avoiding repeated string storage
-- across 1.3M rows.
CREATE TABLE IF NOT EXISTS vendors (
  vendor_id   INTEGER PRIMARY KEY,
  vendor_name TEXT    NOT NULL        -- Full company name
);

INSERT OR IGNORE INTO vendors VALUES (1, 'vendor1');
INSERT OR IGNORE INTO vendors VALUES (2, 'vendor2');

-- ── Dimension: time_dims ────────────────────────────────────────────────────
-- Pre-computed time decomposition.
-- Maximum cardinality: 24 hours × 7 days × 6 months = 1,008 rows.
-- Trips store a single time_id FK instead of three repeated INTEGER columns,
-- reducing row size and enabling fast time-based aggregations via a tiny JOIN.
CREATE TABLE IF NOT EXISTS time_dims (
  time_id     INTEGER PRIMARY KEY,
  hour        INTEGER NOT NULL,   -- 0–23
  day_of_week INTEGER NOT NULL,   -- 0=Sunday … 6=Saturday
  month       INTEGER NOT NULL    -- 1–12
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_time_dims_hk
  ON time_dims(hour, day_of_week, month);

-- ── Fact: trips ─────────────────────────────────────────────────────────────
-- Core fact table. One row per validated taxi trip.
-- All three derived features are computed during ETL and stored as indexed
-- columns — eliminates runtime computation on every query.
CREATE TABLE IF NOT EXISTS trips (
  id                 TEXT    PRIMARY KEY,    -- Original trip ID from dataset
  vendor_id          INTEGER REFERENCES vendors(vendor_id),
  pickup_datetime    TEXT    NOT NULL,       -- ISO 8601 "YYYY-MM-DD HH:MM:SS"
  dropoff_datetime   TEXT,                  -- Nullable — not used in aggregations
  passenger_count    INTEGER NOT NULL,       -- 1–6 (validated)
  pickup_longitude   REAL    NOT NULL,
  pickup_latitude    REAL    NOT NULL,
  dropoff_longitude  REAL    NOT NULL,
  dropoff_latitude   REAL    NOT NULL,
  store_and_fwd_flag TEXT,                  -- 'N' or 'Y'
  trip_duration      INTEGER NOT NULL,       -- Seconds (60–14400, validated)

  -- ── Derived Features (computed once at ETL, indexed for query performance) ──
  trip_distance_km   REAL    NOT NULL,  -- Haversine great-circle distance (km)
  speed_kmh          REAL    NOT NULL,  -- trip_distance_km / (trip_duration / 3600)
  fare_estimate      REAL    NOT NULL,  -- $2.50 + $1.56*dist_km + $0.35*(dur/60)

  -- ── Normalised time FK (replaces denormalised hour/day_of_week/month) ───────
  time_id            INTEGER REFERENCES time_dims(time_id)
);

-- ── Pre-aggregated stats cache ───────────────────────────────────────────────
-- Populated once after ETL completion by buildStatsCache() in server.js.
-- Every dashboard chart and KPI card reads from this table via a single
-- key lookup — guarantees <100ms API response time regardless of dataset size.
-- Keys: kpis | hourly_volume | fare_by_hour | speed_by_hour | daily_volume |
--       day_multi | vendor_volume | passenger | monthly | dist_buckets |
--       speed_dist | hour_density | zscore_stats | stats_summary
CREATE TABLE IF NOT EXISTS stats_cache (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL         -- JSON blob (array or object)
);

-- ── Meta ─────────────────────────────────────────────────────────────────────
-- Lightweight key-value store for ETL state flags.
-- Key 'loaded' is set after a successful pipeline run; its presence prevents
-- re-processing on subsequent server starts.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ── Indexes on trips ─────────────────────────────────────────────────────────
-- Covering indexes for the most common filter + sort patterns.
CREATE INDEX IF NOT EXISTS idx_vendor  ON trips(vendor_id);
CREATE INDEX IF NOT EXISTS idx_time    ON trips(time_id);
CREATE INDEX IF NOT EXISTS idx_speed   ON trips(speed_kmh);
CREATE INDEX IF NOT EXISTS idx_dist    ON trips(trip_distance_km);
CREATE INDEX IF NOT EXISTS idx_pickup  ON trips(pickup_datetime);
CREATE INDEX IF NOT EXISTS idx_dur     ON trips(trip_duration);
CREATE INDEX IF NOT EXISTS idx_fare    ON trips(fare_estimate);

-- ── Data Cleaning Rules Applied During Ingestion ─────────────────────────────
-- A row is excluded (skipped, not inserted) if ANY condition below is true:
--   1. trip_duration  < 60s   OR > 14400s   — impossibly short or >4 hours
--   2. passenger_count < 1    OR > 6         — invalid occupancy
--   3. any coordinate outside NYC bounds     — lat 40.45–40.92, lon -74.27 to -73.62
--   4. haversine_distance < 0.1 OR > 200 km  — GPS noise or unrealistic trip
--   5. speed_kmh < 1          OR > 150       — stationary or physically impossible
--   6. any required field is NULL / NaN / unparseable
-- All exclusion counts are logged to stdout at pipeline completion.

-- ── Entity-Relationship Summary ──────────────────────────────────────────────
--
--   vendors (1) ──────< trips (M)
--   time_dims (1) ────< trips (M)
--   stats_cache      — standalone key-value cache (no FK)
--   meta             — standalone key-value state store (no FK)
--
--   vendors.vendor_id   → trips.vendor_id   (FK, 2 distinct values)
--   time_dims.time_id   → trips.time_id     (FK, ≤1008 distinct values)
