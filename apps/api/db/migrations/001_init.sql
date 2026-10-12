-- Fleet fuel platform: initial schema.
-- Every business table carries company_id: one platform, many companies, data kept apart.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- TimescaleDB speeds up the telemetry table; the schema still works without it.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'TimescaleDB not available, telemetry stays a plain table';
END $$;

-- ---------------------------------------------------------------- companies & people

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  country     text NOT NULL DEFAULT 'ZM',
  currency    text NOT NULL DEFAULT 'ZMW',
  utc_offset_hours numeric NOT NULL DEFAULT 2,
  -- per-company thresholds: alert tolerances, idling limit, gradient cut-offs ...
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  email         text,
  phone         text,
  whatsapp      text,
  role          text NOT NULL CHECK (role IN ('admin', 'fleet_manager', 'owner', 'driver', 'depot_attendant')),
  password_hash text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, email)
);

-- ---------------------------------------------------------------- fleet

CREATE TABLE vehicles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  registration          text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('truck', 'bus', 'van')),
  make                  text,
  model                 text,
  year                  int,
  fuel_type             text NOT NULL DEFAULT 'diesel' CHECK (fuel_type IN ('diesel', 'petrol')),
  tank_capacity_l       numeric NOT NULL,
  expected_l_per_100km  numeric,
  max_load_kg           numeric,
  seats                 int,
  -- tracker / fuel sensor installed in this vehicle
  device_id             text UNIQUE,
  -- engine reports litres burned over the CAN bus (more precise than the tank sensor)
  can_fuel_counter      boolean NOT NULL DEFAULT false,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, registration)
);

CREATE TABLE routes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code         text NOT NULL,
  name         text NOT NULL,
  distance_km  numeric,
  surface      text NOT NULL DEFAULT 'tar' CHECK (surface IN ('tar', 'gravel')),
  -- ordered [lon, lat] points, used later for off-route detection
  path         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE trips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id),
  driver_id    uuid REFERENCES users(id),
  route_id     uuid REFERENCES routes(id),
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  load_kg      numeric,
  passengers   int,
  load_source  text CHECK (load_source IN ('sensor', 'manual', 'passengers')),
  weather      text CHECK (weather IN ('dry', 'rain')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'processed')),
  processed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trips_vehicle_time ON trips (vehicle_id, started_at DESC);

-- ---------------------------------------------------------------- telemetry (time series)

CREATE TABLE telemetry (
  time               timestamptz NOT NULL,
  company_id         uuid NOT NULL,
  vehicle_id         uuid NOT NULL REFERENCES vehicles(id),
  lat                double precision NOT NULL,
  lon                double precision NOT NULL,
  altitude_m         real,
  speed_kmh          real NOT NULL,
  heading_deg        real,
  ignition           boolean NOT NULL,
  fuel_level_l       real,
  fuel_used_total_l  double precision,
  odometer_km        double precision,
  harsh_accel        boolean NOT NULL DEFAULT false,
  harsh_brake        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (vehicle_id, time)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('telemetry', 'time', chunk_time_interval => interval '1 day');
  END IF;
END $$;

-- ---------------------------------------------------------------- analysis output

CREATE TABLE trip_segments (
  id             bigserial PRIMARY KEY,
  company_id     uuid NOT NULL,
  vehicle_id     uuid NOT NULL REFERENCES vehicles(id),
  trip_id        uuid REFERENCES trips(id) ON DELETE CASCADE,
  driver_id      uuid REFERENCES users(id),
  route_id       uuid REFERENCES routes(id),
  kind           text NOT NULL CHECK (kind IN ('moving', 'idle')),
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz NOT NULL,
  distance_km    real NOT NULL,
  duration_s     int NOT NULL,
  fuel_used_l    real NOT NULL,
  fuel_source    text NOT NULL CHECK (fuel_source IN ('can_counter', 'level_sensor')),
  avg_speed_kmh  real NOT NULL,
  speed_band     text,
  gradient_pct   real,
  gradient       text,
  traffic        text,
  road_shape     text,
  time_of_day    text,
  load_class     text,
  load_kg        real,
  passengers     int,
  harsh_events   int NOT NULL DEFAULT 0,
  surface        text,
  weather        text,
  start_lat      double precision,
  start_lon      double precision
);
CREATE INDEX trip_segments_vehicle_time ON trip_segments (vehicle_id, started_at DESC);
CREATE INDEX trip_segments_company_time ON trip_segments (company_id, started_at DESC);
CREATE INDEX trip_segments_trip ON trip_segments (trip_id);

-- ---------------------------------------------------------------- fuel management

CREATE TABLE depot_tanks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         text NOT NULL,
  fuel_type    text NOT NULL DEFAULT 'diesel',
  capacity_l   numeric NOT NULL,
  -- stock at the moment tracking started; deliveries and dispensing are counted from here
  opening_level_l numeric NOT NULL DEFAULT 0,
  opening_at   timestamptz NOT NULL DEFAULT now(),
  lat          double precision,
  lon          double precision,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE depot_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tank_id       uuid NOT NULL REFERENCES depot_tanks(id),
  supplier      text,
  litres        numeric NOT NULL CHECK (litres > 0),
  price_per_l   numeric,
  delivered_at  timestamptz NOT NULL,
  recorded_by   uuid REFERENCES users(id)
);

-- physical dip readings of a depot tank, compared with deliveries minus dispensing
CREATE TABLE depot_dips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tank_id      uuid NOT NULL REFERENCES depot_tanks(id),
  litres       numeric NOT NULL,
  measured_at  timestamptz NOT NULL,
  measured_by  uuid REFERENCES users(id)
);

-- every refuel of a vehicle, whatever the source
CREATE TABLE refuels (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vehicle_id         uuid NOT NULL REFERENCES vehicles(id),
  driver_id          uuid REFERENCES users(id),
  source             text NOT NULL CHECK (source IN ('depot', 'fuel_card', 'cash')),
  depot_tank_id      uuid REFERENCES depot_tanks(id),
  litres             numeric NOT NULL CHECK (litres > 0),
  price_per_l        numeric,
  total_cost         numeric,
  odometer_km        numeric,
  station_name       text,
  lat                double precision,
  lon                double precision,
  receipt_photo_url  text,
  card_txn_ref       text,
  pump_reading       numeric,
  occurred_at        timestamptz NOT NULL,
  recorded_by        uuid REFERENCES users(id),
  -- filled by reconciliation: litres the fuel sensor actually saw go in
  sensor_litres      numeric,
  matched_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refuels_vehicle_time ON refuels (vehicle_id, occurred_at DESC);

-- fuel level rises and drops found in telemetry
CREATE TABLE fuel_events (
  id           bigserial PRIMARY KEY,
  company_id   uuid NOT NULL,
  vehicle_id   uuid NOT NULL REFERENCES vehicles(id),
  type         text NOT NULL CHECK (type IN ('rise', 'drop_while_parked')),
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  litres       real NOT NULL,
  lat          double precision,
  lon          double precision,
  refuel_id    uuid REFERENCES refuels(id),
  UNIQUE (vehicle_id, type, started_at)
);

-- ---------------------------------------------------------------- alerts

CREATE TABLE alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vehicle_id   uuid REFERENCES vehicles(id),
  driver_id    uuid REFERENCES users(id),
  type         text NOT NULL CHECK (type IN (
                 'drop_while_parked', 'refuel_mismatch', 'refuel_without_record', 'refuel_over_capacity',
                 'abnormal_consumption', 'off_route', 'excessive_idling', 'depot_stock_gap',
                 'device_tampering', 'rising_consumption')),
  severity     text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  litres       numeric,
  occurred_at  timestamptz NOT NULL,
  lat          double precision,
  lon          double precision,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- stable key from the analysis so re-running it never duplicates an alert
  dedupe_key   text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'explained', 'confirmed_loss')),
  resolved_by  uuid REFERENCES users(id),
  resolution_note text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX alerts_dedupe ON alerts (company_id, dedupe_key);
CREATE INDEX alerts_company_open ON alerts (company_id, status, occurred_at DESC);
