-- Scanner funnel per scan (main engine and shadow variants) and shadow-book closed trades.
CREATE TABLE scan_funnel (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL,
  variant   TEXT NOT NULL,
  data      JSONB NOT NULL
);
CREATE INDEX scan_funnel_variant_at ON scan_funnel(variant, at);

CREATE TABLE shadow_trades (
  id                BIGSERIAL PRIMARY KEY,
  variant           TEXT NOT NULL,
  mint              TEXT NOT NULL,
  symbol            TEXT,
  opened_at         TIMESTAMPTZ NOT NULL,
  closed_at         TIMESTAMPTZ NOT NULL,
  cost_lamports     NUMERIC(78,0) NOT NULL,
  proceeds_lamports NUMERIC(78,0) NOT NULL,
  pnl_lamports      NUMERIC(78,0) NOT NULL,
  exit_reason       TEXT NOT NULL,
  entry_score       DOUBLE PRECISION,
  entry_why         TEXT
);
CREATE INDEX shadow_trades_variant ON shadow_trades(variant, closed_at);
