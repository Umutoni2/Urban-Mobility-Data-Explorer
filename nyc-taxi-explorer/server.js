'use strict';

/**
 * NYC Taxi Explorer — Backend Server
 * Node.js + SQLite (better-sqlite3)
 * Single-file backend: data processing, DB management, REST API, static serving
 */

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const url      = require('url');
const Database = require('better-sqlite3');

const PORT     = 3001;
const DB_PATH  = path.join(__dirname, 'taxi.db');
const CSV_PATH = path.join(__dirname, 'train.csv');

// ═══════════════════════════════════════════════════════════════════
// ALGORITHM IMPLEMENTATIONS (manual — no built-in library functions)
// ═══════════════════════════════════════════════════════════════════

/**
 * Haversine Distance Formula (manual implementation)
 * Computes great-circle distance between two GPS coordinates.
 * Time complexity: O(1)  Space complexity: O(1)
 *
 * Pseudo-code:
 *   R = 6371 (Earth radius km)
 *   dLat = (lat2 - lat1) * π/180
 *   dLon = (lon2 - lon1) * π/180
 *   a = sin²(dLat/2) + cos(lat1r)*cos(lat2r)*sin²(dLon/2)
 *   return R * 2 * atan2(√a, √(1−a))
 */
function haversine(lat1, lon1, lat2, lon2) {
  const R       = 6371;
  const toRad   = x => x * Math.PI / 180;
  const dLat    = toRad(lat2 - lat1);
  const dLon    = toRad(lon2 - lon1);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a = sinDLat * sinDLat +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinDLon * sinDLon;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Z-Score Anomaly Detection (manual implementation)
 * Uses variance shortcut: Var(X) = E[X²] − (E[X])²
 * Both computed in a single SQL aggregation — O(n) time, O(1) space.
 *
 * Pseudo-code:
 *   mean     = sumX / n
 *   variance = (sumX2 / n) − mean²
 *   std      = √variance
 *   z_i      = (x_i − mean) / std
 *   flag if |z_i| > threshold
 */
function computeZScoreStats(sumX, sumX2, n) {
  if (n === 0) return { mean: 0, std: 1 };
  const mean     = sumX / n;
  const variance = Math.max(0, (sumX2 / n) - (mean * mean));
  const std      = Math.sqrt(variance);
  return { mean, std: std > 0.0001 ? std : 1 };
}

/**
 * Fare Estimation (derived feature)
 * NYC taxi approximation: base + per-km + per-minute components
 * $2.50 base + $1.56/km (≈ $2.50/mile) + $0.35/min idle surcharge
 */
function estimateFare(distKm, durationSec) {
  return 2.50 + (distKm * 1.56) + ((durationSec / 60) * 0.35);
}

// Day name lookup (no library)
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ═══════════════════════════════════════════════════════════════════
// DATABASE SETUP — normalized schema
// ═══════════════════════════════════════════════════════════════════

const db = new Database(DB_PATH);

// Maximum SQLite performance for bulk loading
db.exec(`
  PRAGMA journal_mode   = WAL;
  PRAGMA synchronous    = OFF;
  PRAGMA cache_size     = -131072;
  PRAGMA temp_store     = MEMORY;
  PRAGMA mmap_size      = 536870912;
  PRAGMA page_size      = 65536;
  PRAGMA locking_mode   = EXCLUSIVE;
`);

db.exec(`
  -- ── Dimension: vendors ──────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS vendors (
    vendor_id   INTEGER PRIMARY KEY,
    vendor_name TEXT NOT NULL
  );

  INSERT OR IGNORE INTO vendors VALUES (1, 'Vendor 1');
  INSERT OR IGNORE INTO vendors VALUES (2, 'Vendor 2');

  -- ── Dimension: time_dims ────────────────────────────────────────
  -- One row per unique (hour, day_of_week, month) combination.
  -- Pre-computed so trips table only stores a FK integer.
  CREATE TABLE IF NOT EXISTS time_dims (
    time_id     INTEGER PRIMARY KEY,
    hour        INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    month       INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_time_dims_hk ON time_dims(hour, day_of_week, month);

  -- ── Fact: trips ──────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS trips (
    id                TEXT    PRIMARY KEY,
    vendor_id         INTEGER REFERENCES vendors(vendor_id),
    pickup_datetime   TEXT    NOT NULL,
    dropoff_datetime  TEXT,
    passenger_count   INTEGER NOT NULL,
    pickup_longitude  REAL    NOT NULL,
    pickup_latitude   REAL    NOT NULL,
    dropoff_longitude REAL    NOT NULL,
    dropoff_latitude  REAL    NOT NULL,
    store_and_fwd_flag TEXT,
    trip_duration     INTEGER NOT NULL,
    trip_distance_km  REAL    NOT NULL,
    speed_kmh         REAL    NOT NULL,
    fare_estimate     REAL    NOT NULL,
    time_id           INTEGER REFERENCES time_dims(time_id)
  );

  -- ── Pre-aggregated stats cache ───────────────────────────────────
  -- Populated once after ETL. All chart/KPI queries read from here
  -- instead of scanning the full trips table — guarantees <1s responses.
  CREATE TABLE IF NOT EXISTS stats_cache (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL        -- JSON blob
  );

  -- ── Meta ─────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- ── Indexes on trips ─────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_vendor   ON trips(vendor_id);
  CREATE INDEX IF NOT EXISTS idx_time     ON trips(time_id);
  CREATE INDEX IF NOT EXISTS idx_speed    ON trips(speed_kmh);
  CREATE INDEX IF NOT EXISTS idx_dist     ON trips(trip_distance_km);
  CREATE INDEX IF NOT EXISTS idx_pickup   ON trips(pickup_datetime);
  CREATE INDEX IF NOT EXISTS idx_dur      ON trips(trip_duration);
  CREATE INDEX IF NOT EXISTS idx_fare     ON trips(fare_estimate);
`);

// ── Build time_dims lookup (432 possible combinations: 24×7×6) ──────
const getOrCreateTimeDim = (() => {
  const cache  = new Map();
  const select = db.prepare('SELECT time_id FROM time_dims WHERE hour=? AND day_of_week=? AND month=?');
  const insert = db.prepare('INSERT OR IGNORE INTO time_dims(hour,day_of_week,month) VALUES(?,?,?)');
  const lastId = db.prepare('SELECT last_insert_rowid() AS id');

  return (hour, dow, month) => {
    const k = `${hour}|${dow}|${month}`;
    if (cache.has(k)) return cache.get(k);
    let row = select.get(hour, dow, month);
    if (!row) {
      insert.run(hour, dow, month);
      row = { time_id: lastId.get().id };
    }
    cache.set(k, row.time_id);
    return row.time_id;
  };
})();

// ═══════════════════════════════════════════════════════════════════
// CSV PROCESSING PIPELINE
// ═══════════════════════════════════════════════════════════════════

async function processCSV() {
  const loaded = db.prepare("SELECT value FROM meta WHERE key='loaded'").get();
  if (loaded) {
    console.log(`[DB] Already loaded — ${loaded.value} trips in database.`);
    return;
  }

  if (!fs.existsSync(CSV_PATH)) {
    console.error('[CSV] ERROR: train.csv not found. Place it in the project root directory.');
    console.error('[CSV] Download from: https://www.kaggle.com/c/nyc-taxi-trip-duration/data');
    return;
  }

  console.log('[CSV] Starting data pipeline...');
  const startTime = Date.now();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO trips
      (id, vendor_id, pickup_datetime, dropoff_datetime, passenger_count,
       pickup_longitude, pickup_latitude, dropoff_longitude, dropoff_latitude,
       store_and_fwd_flag, trip_duration, trip_distance_km, speed_kmh,
       fare_estimate, time_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  // 200,000-row batches: each transaction covers 200k rows — dramatically
  // reduces commit overhead vs 500-row batches (400× fewer transactions).
  const BATCH_SIZE = 200000;
  const insertBatch = db.transaction(rows => {
    for (const r of rows) insert.run(r);
  });

  const rl = readline.createInterface({
    input: fs.createReadStream(CSV_PATH, {
      encoding  : 'utf8',
      highWaterMark: 4 * 1024 * 1024   // 4 MB read buffer
    }),
    crlfDelay: Infinity
  });

  let lineNum  = 0;
  let inserted = 0;
  let skipped  = 0;
  let batch    = [];

  const excl = { missing: 0, duration: 0, coords: 0, distance: 0, speed: 0, pax: 0 };

  const NYC_LAT_MIN = 40.45, NYC_LAT_MAX = 40.92;
  const NYC_LON_MIN = -74.27, NYC_LON_MAX = -73.62;

  for await (const line of rl) {
    lineNum++;
    if (lineNum === 1) continue; // skip header

    const cols = line.split(',');
    if (cols.length < 11) { excl.missing++; skipped++; continue; }

    const [rawId, rawVendor, pickupDt, dropoffDt, rawPax,
           rawPLon, rawPLat, rawDLon, rawDLat,
           rawFlag, rawDur] = cols;

    const dur  = parseInt(rawDur, 10);
    const pLat = parseFloat(rawPLat);
    const pLon = parseFloat(rawPLon);
    const dLat = parseFloat(rawDLat);
    const dLon = parseFloat(rawDLon);
    const pax  = parseInt(rawPax, 10);
    const vend = parseInt(rawVendor, 10);

    if (!rawId || isNaN(dur) || isNaN(pLat) || isNaN(pLon) || isNaN(dLat) || isNaN(dLon)) {
      excl.missing++; skipped++; continue;
    }
    if (dur < 60 || dur > 14400)       { excl.duration++; skipped++; continue; }
    if (pax < 1  || pax > 6)           { excl.pax++;      skipped++; continue; }
    if (pLat < NYC_LAT_MIN || pLat > NYC_LAT_MAX ||
        pLon < NYC_LON_MIN || pLon > NYC_LON_MAX ||
        dLat < NYC_LAT_MIN || dLat > NYC_LAT_MAX ||
        dLon < NYC_LON_MIN || dLon > NYC_LON_MAX) {
      excl.coords++; skipped++; continue;
    }

    const distKm  = haversine(pLat, pLon, dLat, dLon);
    if (distKm < 0.1 || distKm > 200)  { excl.distance++; skipped++; continue; }

    const speedKmh = distKm / (dur / 3600);
    if (speedKmh < 1 || speedKmh > 150) { excl.speed++; skipped++; continue; }

    const fare = estimateFare(distKm, dur);

    const dt = new Date(pickupDt);
    if (isNaN(dt.getTime())) { excl.missing++; skipped++; continue; }

    const hour      = dt.getHours();
    const dayOfWeek = dt.getDay();
    const month     = dt.getMonth() + 1;
    const timeId    = getOrCreateTimeDim(hour, dayOfWeek, month);

    batch.push([
      rawId.trim(), vend, pickupDt.trim(), dropoffDt ? dropoffDt.trim() : null, pax,
      pLon, pLat, dLon, dLat,
      rawFlag ? rawFlag.trim() : 'N',
      dur,
      Math.round(distKm   * 10000) / 10000,
      Math.round(speedKmh * 10000) / 10000,
      Math.round(fare     * 100)   / 100,
      timeId
    ]);

    if (batch.length >= BATCH_SIZE) {
      insertBatch(batch);
      inserted += batch.length;
      batch = [];
      console.log(`[CSV]   Processed ${inserted.toLocaleString()} trips...`);
    }
  }

  if (batch.length > 0) {
    insertBatch(batch);
    inserted += batch.length;
  }

  db.prepare("INSERT OR REPLACE INTO meta VALUES ('loaded', ?)").run(String(inserted));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[CSV] Pipeline complete in ${elapsed}s`);
  console.log(`[CSV]   Inserted : ${inserted.toLocaleString()}`);
  console.log(`[CSV]   Skipped  : ${skipped.toLocaleString()}`);
  console.log(`[CSV]   Reasons  : duration=${excl.duration} coords=${excl.coords} dist=${excl.distance} speed=${excl.speed} pax=${excl.pax} missing=${excl.missing}`);

  // Restore safe sync after bulk load
  db.exec(`PRAGMA synchronous = NORMAL; PRAGMA locking_mode = NORMAL;`);

  // Build stats cache so every chart query is O(1)
  console.log('[DB] Building stats cache...');
  buildStatsCache();
  console.log('[DB] Stats cache ready.');
}

// ═══════════════════════════════════════════════════════════════════
// STATS CACHE — pre-aggregate everything charts need
// ═══════════════════════════════════════════════════════════════════

function buildStatsCache() {
  const setCache = db.prepare("INSERT OR REPLACE INTO stats_cache VALUES (?,?)");

  const storeJSON = (key, query) => {
    const result = db.prepare(query).all ? db.prepare(query).all() : db.prepare(query).get();
    setCache.run(key, JSON.stringify(result));
  };
  const storeOne  = (key, query) => {
    const result = db.prepare(query).get();
    setCache.run(key, JSON.stringify(result));
  };

  // KPIs
  storeOne('kpis', `
    SELECT
      COUNT(*)                AS total_trips,
      AVG(trip_duration)      AS avg_duration,
      AVG(trip_distance_km)   AS avg_distance,
      AVG(speed_kmh)          AS avg_speed,
      AVG(fare_estimate)      AS avg_fare,
      SUM(trip_distance_km)   AS total_distance
    FROM trips
  `);

  // Hourly volume + fare + speed — joined through time_dims
  storeJSON('hourly_volume', `
    SELECT td.hour, COUNT(*) AS cnt
    FROM trips t JOIN time_dims td ON t.time_id = td.time_id
    GROUP BY td.hour ORDER BY td.hour
  `);
  storeJSON('fare_by_hour', `
    SELECT td.hour, AVG(t.fare_estimate) AS avg_fare, COUNT(*) AS cnt
    FROM trips t JOIN time_dims td ON t.time_id = td.time_id
    GROUP BY td.hour ORDER BY td.hour
  `);
  storeJSON('speed_by_hour', `
    SELECT td.hour, AVG(t.speed_kmh) AS avg_speed
    FROM trips t JOIN time_dims td ON t.time_id = td.time_id
    GROUP BY td.hour ORDER BY td.hour
  `);

  // Daily
  storeJSON('daily_volume', `
    SELECT td.day_of_week, COUNT(*) AS cnt
    FROM trips t JOIN time_dims td ON t.time_id = td.time_id
    GROUP BY td.day_of_week ORDER BY td.day_of_week
  `);
  storeJSON('day_multi', `
    SELECT
      td.day_of_week,
      COUNT(*)              AS cnt,
      AVG(t.fare_estimate)  AS avg_fare,
      AVG(t.trip_distance_km) AS avg_dist,
      AVG(t.speed_kmh)      AS avg_speed
    FROM trips t JOIN time_dims td ON t.time_id = td.time_id
    GROUP BY td.day_of_week ORDER BY td.day_of_week
  `);

  // Vendor breakdown
  storeJSON('vendor_volume', `
    SELECT t.vendor_id, v.vendor_name, COUNT(*) AS cnt
    FROM trips t JOIN vendors v ON t.vendor_id = v.vendor_id
    GROUP BY t.vendor_id ORDER BY t.vendor_id
  `);

  // Passenger
  storeJSON('passenger', `
    SELECT passenger_count, COUNT(*) AS cnt
    FROM trips GROUP BY passenger_count ORDER BY passenger_count
  `);

  // Monthly
  storeJSON('monthly', `
    SELECT td.month, COUNT(*) AS cnt
    FROM trips t JOIN time_dims td ON t.time_id = td.time_id
    GROUP BY td.month ORDER BY td.month
  `);

  // Distance buckets
  storeJSON('dist_buckets', `
    SELECT
      CASE
        WHEN trip_distance_km < 2  THEN '0-2 km'
        WHEN trip_distance_km < 5  THEN '2-5 km'
        WHEN trip_distance_km < 10 THEN '5-10 km'
        WHEN trip_distance_km < 20 THEN '10-20 km'
        ELSE '20+ km'
      END AS bucket,
      COUNT(*)           AS cnt,
      AVG(fare_estimate) AS avg_fare
    FROM trips GROUP BY bucket ORDER BY MIN(trip_distance_km)
  `);

  // Speed distribution
  storeJSON('speed_dist', `
    SELECT
      CASE
        WHEN speed_kmh < 10 THEN '<10'
        WHEN speed_kmh < 20 THEN '10-20'
        WHEN speed_kmh < 30 THEN '20-30'
        WHEN speed_kmh < 40 THEN '30-40'
        WHEN speed_kmh < 60 THEN '40-60'
        ELSE '60+'
      END AS bucket,
      COUNT(*) AS cnt
    FROM trips GROUP BY bucket ORDER BY MIN(speed_kmh)
  `);

  // Hour density (for map tab)
  storeJSON('hour_density', `
    SELECT td.hour, COUNT(*) AS cnt
    FROM trips t JOIN time_dims td ON t.time_id = td.time_id
    GROUP BY td.hour ORDER BY td.hour
  `);

  // Z-score stats (anomaly detection pre-compute)
  storeOne('zscore_stats', `
    SELECT
      COUNT(*)                              AS n,
      SUM(trip_duration)                    AS s_dur,
      SUM(trip_duration * trip_duration)    AS s_dur2,
      SUM(trip_distance_km)                 AS s_dist,
      SUM(trip_distance_km*trip_distance_km) AS s_dist2,
      SUM(speed_kmh)                        AS s_spd,
      SUM(speed_kmh * speed_kmh)            AS s_spd2,
      SUM(fare_estimate)                    AS s_fare,
      SUM(fare_estimate * fare_estimate)    AS s_fare2
    FROM trips
  `);

  // Summary stats for /api/stats endpoint
  storeOne('stats_summary', `
    SELECT
      COUNT(*)               AS trips,
      AVG(trip_distance_km)  AS avg_dist,
      AVG(fare_estimate)     AS avg_fare,
      AVG(speed_kmh)         AS avg_speed,
      MIN(pickup_datetime)   AS dt_min,
      MAX(pickup_datetime)   AS dt_max
    FROM trips
  `);
}

// Helper: read from cache (falls back to live query if cache is empty)
function fromCache(key) {
  const row = db.prepare("SELECT value FROM stats_cache WHERE key=?").get(key);
  if (!row) return null;
  return JSON.parse(row.value);
}

// ═══════════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═══════════════════════════════════════════════════════════════════

function sendJSON(res, data, status) {
  const body = JSON.stringify(data);
  res.writeHead(status || 200, {
    'Content-Type'                : 'application/json',
    'Access-Control-Allow-Origin' : '*',
    'Cache-Control'               : 'public, max-age=300'
  });
  res.end(body);
}

function sendError(res, msg, status) {
  sendJSON(res, { error: msg }, status || 500);
}

// ═══════════════════════════════════════════════════════════════════
// API HANDLERS — all chart/KPI reads from stats_cache (sub-second)
// ═══════════════════════════════════════════════════════════════════

function apiHealth(req, res) {
  const row = db.prepare("SELECT value FROM meta WHERE key='loaded'").get();
  sendJSON(res, { status: 'ok', trips: row ? parseInt(row.value, 10) : 0 });
}

function apiStats(req, res) {
  const row = fromCache('stats_summary');
  if (!row) { sendError(res, 'Cache not ready', 503); return; }
  sendJSON(res, {
    trips     : row.trips,
    avg_dist  : +row.avg_dist.toFixed(2),
    avg_fare  : +row.avg_fare.toFixed(2),
    avg_speed : +row.avg_speed.toFixed(1),
    dt_min    : row.dt_min,
    dt_max    : row.dt_max
  });
}

function apiOverview(req, res) {
  sendJSON(res, {
    kpis        : fromCache('kpis'),
    hourly      : fromCache('hourly_volume'),
    daily       : fromCache('daily_volume'),
    vendor      : fromCache('vendor_volume'),
    passenger   : fromCache('passenger'),
    monthly     : fromCache('monthly'),
    distBuckets : fromCache('dist_buckets'),
    speedDist   : fromCache('speed_dist')
  });
}

function apiTime(req, res) {
  sendJSON(res, {
    fareByHour  : fromCache('fare_by_hour'),
    speedByHour : fromCache('speed_by_hour'),
    dayMulti    : fromCache('day_multi')
  });
}

function apiTrips(req, res) {
  const q      = url.parse(req.url, true).query;
  const page   = Math.max(1, parseInt(q.page, 10) || 1);
  const LIMIT  = 20;
  const OFFSET = (page - 1) * LIMIT;

  const whereParts = [];
  const params     = [];

  if (q.hour !== undefined && q.hour !== '') {
    whereParts.push('td.hour = ?');
    params.push(parseInt(q.hour, 10));
  }
  if (q.day !== undefined && q.day !== '') {
    const di = DAY_NAMES.indexOf(q.day);
    if (di >= 0) { whereParts.push('td.day_of_week = ?'); params.push(di); }
  }
  if (q.vendor !== undefined && q.vendor !== '') {
    whereParts.push('t.vendor_id = ?');
    params.push(parseInt(q.vendor, 10));
  }

  const joinSQL  = 'JOIN time_dims td ON t.time_id = td.time_id';
  const whereSQL = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';

  const ALLOWED_SORT = new Set([
    'pickup_datetime','trip_distance_km','trip_duration',
    'speed_kmh','fare_estimate','vendor_id','passenger_count'
  ]);
  const sort  = ALLOWED_SORT.has(q.sort) ? `t.${q.sort}` : 't.pickup_datetime';
  const order = q.order === 'ASC' ? 'ASC' : 'DESC';

  const total = db.prepare(
    `SELECT COUNT(*) AS cnt FROM trips t ${joinSQL} ${whereSQL}`
  ).get(...params).cnt;

  const trips = db.prepare(`
    SELECT t.id, t.vendor_id, t.pickup_datetime, t.passenger_count,
           t.trip_duration, t.trip_distance_km, t.speed_kmh, t.fare_estimate,
           td.hour, td.day_of_week
    FROM trips t ${joinSQL}
    ${whereSQL}
    ORDER BY ${sort} ${order}
    LIMIT ? OFFSET ?
  `).all(...params, LIMIT, OFFSET);

  sendJSON(res, { trips, total, page, pages: Math.ceil(total / LIMIT) });
}

function apiMap(req, res) {
  const q = url.parse(req.url, true).query;

  // Efficient sample using rowid modulo (no ORDER BY RANDOM() scan)
  const total     = db.prepare('SELECT COUNT(*) AS cnt FROM trips').get().cnt;
  const skipEvery = Math.max(1, Math.floor(total / 600));

  let points;
  if (q.hour !== undefined && q.hour !== '') {
    const h = parseInt(q.hour, 10);
    points = db.prepare(`
      SELECT t.pickup_latitude AS lat, t.pickup_longitude AS lon, t.speed_kmh
      FROM trips t JOIN time_dims td ON t.time_id = td.time_id
      WHERE td.hour = ? AND (t.rowid % ?) = 0
      LIMIT 500
    `).all(h, skipEvery);
  } else {
    points = db.prepare(`
      SELECT pickup_latitude AS lat, pickup_longitude AS lon, speed_kmh
      FROM trips WHERE (rowid % ?) = 0 LIMIT 500
    `).all(skipEvery);
  }

  const dfSkip   = Math.max(1, Math.floor(total / 400));
  const distFare = db.prepare(`
    SELECT trip_distance_km AS dist, fare_estimate AS fare
    FROM trips WHERE (rowid % ?) = 0 LIMIT 300
  `).all(dfSkip);

  sendJSON(res, {
    points,
    hourDensity : fromCache('hour_density'),
    distFare,
    sampleSize  : points.length
  });
}

function apiAnomalies(req, res) {
  // All population stats come from the pre-built cache — O(1) read
  const S = fromCache('zscore_stats');
  if (!S) { sendError(res, 'Cache not ready', 503); return; }

  const n = S.n;
  const statDur  = computeZScoreStats(S.s_dur,  S.s_dur2,  n);
  const statDist = computeZScoreStats(S.s_dist, S.s_dist2, n);
  const statSpd  = computeZScoreStats(S.s_spd,  S.s_spd2,  n);
  const statFare = computeZScoreStats(S.s_fare, S.s_fare2, n);

  const THRESHOLD = 2.5;
  const durMin  = statDur.mean  - THRESHOLD * statDur.std;
  const durMax  = statDur.mean  + THRESHOLD * statDur.std;
  const distMin = statDist.mean - THRESHOLD * statDist.std;
  const distMax = statDist.mean + THRESHOLD * statDist.std;
  const spdMin  = statSpd.mean  - THRESHOLD * statSpd.std;
  const spdMax  = statSpd.mean  + THRESHOLD * statSpd.std;
  const fareMin = statFare.mean - THRESHOLD * statFare.std;
  const fareMax = statFare.mean + THRESHOLD * statFare.std;

  const anomalyTrips = db.prepare(`
    SELECT id, pickup_datetime, trip_duration, trip_distance_km, speed_kmh, fare_estimate
    FROM trips
    WHERE trip_duration      NOT BETWEEN ? AND ?
       OR trip_distance_km   NOT BETWEEN ? AND ?
       OR speed_kmh          NOT BETWEEN ? AND ?
       OR fare_estimate      NOT BETWEEN ? AND ?
    ORDER BY speed_kmh DESC
    LIMIT 200
  `).all(durMin, durMax, distMin, distMax, spdMin, spdMax, fareMin, fareMax);

  const flagged = anomalyTrips.map(t => {
    const flags = [];
    const zDur  = (t.trip_duration    - statDur.mean)  / statDur.std;
    const zDist = (t.trip_distance_km - statDist.mean) / statDist.std;
    const zSpd  = (t.speed_kmh        - statSpd.mean)  / statSpd.std;
    const zFare = (t.fare_estimate    - statFare.mean) / statFare.std;
    if (Math.abs(zDur)  > THRESHOLD) flags.push({ m: 'duration', z: zDur.toFixed(1)  });
    if (Math.abs(zDist) > THRESHOLD) flags.push({ m: 'distance', z: zDist.toFixed(1) });
    if (Math.abs(zSpd)  > THRESHOLD) flags.push({ m: 'speed',    z: zSpd.toFixed(1)  });
    if (Math.abs(zFare) > THRESHOLD) flags.push({ m: 'fare',     z: zFare.toFixed(1) });
    return { ...t, flags };
  });

  const anomalyCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM trips
    WHERE trip_duration    NOT BETWEEN ? AND ?
       OR trip_distance_km NOT BETWEEN ? AND ?
       OR speed_kmh        NOT BETWEEN ? AND ?
       OR fare_estimate    NOT BETWEEN ? AND ?
  `).get(durMin, durMax, distMin, distMax, spdMin, spdMax, fareMin, fareMax).cnt;

  sendJSON(res, {
    stats: {
      total     : n,
      anomalies : anomalyCount,
      pct       : ((anomalyCount / n) * 100).toFixed(1),
      avg_dur   : statDur.mean,   std_dur  : statDur.std,
      avg_dist  : statDist.mean,  std_dist : statDist.std,
      avg_spd   : statSpd.mean,   std_spd  : statSpd.std,
      avg_fare  : statFare.mean,  std_fare : statFare.std
    },
    trips: flagged
  });
}

// ═══════════════════════════════════════════════════════════════════
// HTTP SERVER + ROUTING
// ═══════════════════════════════════════════════════════════════════

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin'  : '*',
      'Access-Control-Allow-Methods' : 'GET, OPTIONS',
      'Access-Control-Allow-Headers' : 'Content-Type'
    });
    res.end();
    return;
  }

  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    const fp = path.join(__dirname, 'index.html');
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(fp));
    } else {
      res.writeHead(404); res.end('index.html not found');
    }
    return;
  }

  try {
    if (pathname === '/api/health')    return apiHealth(req, res);
    if (pathname === '/api/stats')     return apiStats(req, res);
    if (pathname === '/api/overview')  return apiOverview(req, res);
    if (pathname === '/api/time')      return apiTime(req, res);
    if (pathname === '/api/trips')     return apiTrips(req, res);
    if (pathname === '/api/map')       return apiMap(req, res);
    if (pathname === '/api/anomalies') return apiAnomalies(req, res);
  } catch (err) {
    console.error('[API] Error:', err.message);
    sendError(res, 'Internal server error: ' + err.message);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ═══════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════

(async () => {
  console.log('═══════════════════════════════════════');
  console.log('  NYC Taxi Explorer — Backend Server   ');
  console.log('═══════════════════════════════════════');
  await processCSV();
  server.listen(PORT, () => {
    console.log(`[SERVER] Listening at http://localhost:${PORT}`);
    console.log('[SERVER] Open your browser at that URL to start exploring.');
  });
})();