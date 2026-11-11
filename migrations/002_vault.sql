-- Vault contract integration: every distribution event becomes an on-chain Merkle payout list.
CREATE TABLE vault_distributions (
  event_id      BIGINT PRIMARY KEY REFERENCES distribution_events(id),
  epoch         BIGINT NOT NULL UNIQUE,
  root          TEXT NOT NULL,
  data_hash     TEXT NOT NULL,
  total         NUMERIC(78,0) NOT NULL,
  -- prepared → proposed (on chain, in veto window / active) | vetoed | failed
  status        TEXT NOT NULL CHECK (status IN ('prepared','submitting','proposed','vetoed','failed')),
  tx_hash       TEXT,
  signed_tx     TEXT,
  activates_at  TIMESTAMPTZ,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);

-- Daily decisions mirrored into the vault (propose_mode).
CREATE TABLE vault_mode_syncs (
  cycle_id      TEXT PRIMARY KEY,
  mode          TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('submitting','done','failed')),
  tx_hash       TEXT,
  signed_tx     TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);
