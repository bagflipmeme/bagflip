-- DEGEN initial schema. All asset amounts are NUMERIC(78,0) integers in the
-- asset's smallest unit (yoctoNEAR, lamports, token base units).
-- Financial history tables are append-only, enforced by triggers.

CREATE OR REPLACE FUNCTION degen_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- ───────────── identity ─────────────
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  telegram_id   BIGINT NOT NULL UNIQUE,
  username      TEXT,
  first_name    TEXT,
  is_banned     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_challenges (
  id            TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  nonce_b64     TEXT NOT NULL UNIQUE,
  message       TEXT NOT NULL,
  recipient     TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  failed_attempts INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenges_user ON auth_challenges(user_id, created_at DESC);

CREATE TABLE wallets (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  account_id    TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  challenge_id  TEXT NOT NULL REFERENCES auth_challenges(id),
  verified_at   TIMESTAMPTZ NOT NULL,
  unlinked_at   TIMESTAMPTZ
);
-- A NEAR account can be linked to at most one Telegram user at a time.
CREATE UNIQUE INDEX wallets_active_account ON wallets(account_id) WHERE unlinked_at IS NULL;
CREATE INDEX wallets_user ON wallets(user_id) WHERE unlinked_at IS NULL;

-- ───────────── governance ─────────────
CREATE TABLE votes (
  wallet_id     BIGINT PRIMARY KEY REFERENCES wallets(id),
  choice        TEXT NOT NULL CHECK (choice IN ('DISTRIBUTE','AUTO_HUNT')),
  updated_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE vote_events (
  id            BIGSERIAL PRIMARY KEY,
  wallet_id     BIGINT NOT NULL REFERENCES wallets(id),
  user_id       BIGINT NOT NULL REFERENCES users(id),
  choice        TEXT CHECK (choice IN ('DISTRIBUTE','AUTO_HUNT')),
  action        TEXT NOT NULL CHECK (action IN ('vote','revoke','unlink')),
  created_at    TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER vote_events_append_only BEFORE UPDATE OR DELETE ON vote_events FOR EACH ROW EXECUTE FUNCTION degen_forbid_mutation();

CREATE TABLE governance_decisions (
  id                  BIGSERIAL PRIMARY KEY,
  cycle_id            TEXT NOT NULL UNIQUE,
  boundary_at         TIMESTAMPTZ NOT NULL,
  executed_at         TIMESTAMPTZ NOT NULL,
  block_height        BIGINT NOT NULL,
  block_hash          TEXT NOT NULL,
  block_timestamp     TIMESTAMPTZ NOT NULL,
  late_snapshot       BOOLEAN NOT NULL DEFAULT false,
  previous_mode       TEXT NOT NULL,
  effective_mode      TEXT NOT NULL CHECK (effective_mode IN ('INACTIVE','DISTRIBUTE','AUTO_HUNT')),
  changed             BOOLEAN NOT NULL,
  reason              TEXT NOT NULL,
  weight_distribute   NUMERIC(78,0) NOT NULL,
  weight_hunt         NUMERIC(78,0) NOT NULL,
  eligible_supply     NUMERIC(78,0) NOT NULL,
  distinct_wallets    INT NOT NULL,
  quorum_required_bps INT NOT NULL,
  quorum_met          BOOLEAN NOT NULL,
  config              JSONB NOT NULL
);
CREATE TRIGGER governance_decisions_append_only BEFORE UPDATE OR DELETE ON governance_decisions FOR EACH ROW EXECUTE FUNCTION degen_forbid_mutation();

CREATE TABLE governance_snapshot_entries (
  decision_id   BIGINT NOT NULL REFERENCES governance_decisions(id),
  account_id    TEXT NOT NULL,
  wallet_id     BIGINT NOT NULL REFERENCES wallets(id),
  user_id       BIGINT NOT NULL REFERENCES users(id),
  choice        TEXT NOT NULL,
  balance       NUMERIC(78,0) NOT NULL,
  counted       BOOLEAN NOT NULL,
  note          TEXT,
  PRIMARY KEY (decision_id, account_id)
);
CREATE TRIGGER governance_snapshot_append_only BEFORE UPDATE OR DELETE ON governance_snapshot_entries FOR EACH ROW EXECUTE FUNCTION degen_forbid_mutation();

-- ───────────── system state + audit ─────────────
CREATE TABLE system_state (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_audit (
  id            BIGSERIAL PRIMARY KEY,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER admin_audit_append_only BEFORE UPDATE OR DELETE ON admin_audit FOR EACH ROW EXECUTE FUNCTION degen_forbid_mutation();

-- ───────────── durable jobs ─────────────
CREATE TABLE jobs (
  id            BIGSERIAL PRIMARY KEY,
  type          TEXT NOT NULL,
  key           TEXT NOT NULL UNIQUE,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
  run_at        TIMESTAMPTZ NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  max_attempts  INT NOT NULL DEFAULT 8,
  locked_by     TEXT,
  locked_until  TIMESTAMPTZ,
  last_error    TEXT,
  result        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX jobs_ready ON jobs(run_at) WHERE status IN ('queued','running');

-- ───────────── ledger ─────────────
CREATE TABLE ledger_journals (
  id               BIGSERIAL PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL,
  ref_type         TEXT,
  ref_id           TEXT,
  memo             TEXT,
  created_at       TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER ledger_journals_append_only BEFORE UPDATE OR DELETE ON ledger_journals FOR EACH ROW EXECUTE FUNCTION degen_forbid_mutation();

CREATE TABLE ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  journal_id    BIGINT NOT NULL REFERENCES ledger_journals(id),
  account       TEXT NOT NULL,
  asset         TEXT NOT NULL CHECK (asset IN ('NEAR','SOL')),
  amount        NUMERIC(78,0) NOT NULL CHECK (amount <> 0)
);
CREATE INDEX ledger_entries_account ON ledger_entries(account, asset);
CREATE INDEX ledger_entries_journal ON ledger_entries(journal_id);
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION degen_forbid_mutation();

-- ───────────── treasury deposits ─────────────
CREATE TABLE treasury_deposits (
  id              BIGSERIAL PRIMARY KEY,
  tx_hash         TEXT NOT NULL,
  receipt_id      TEXT NOT NULL UNIQUE,
  sender          TEXT NOT NULL,
  asset           TEXT NOT NULL,
  amount          NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  block_height    BIGINT,
  block_timestamp TIMESTAMPTZ,
  source          TEXT NOT NULL CHECK (source IN ('scanner','admin','sim')),
  journal_id      BIGINT REFERENCES ledger_journals(id),
  created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX treasury_deposits_tx ON treasury_deposits(tx_hash);

-- Inflows seen on chain that are not from an allowed sender: never auto-credited.
CREATE TABLE unattributed_inflows (
  id              BIGSERIAL PRIMARY KEY,
  chain           TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  receipt_id      TEXT NOT NULL UNIQUE,
  sender          TEXT NOT NULL,
  asset           TEXT NOT NULL,
  amount          NUMERIC(78,0) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','credited','ignored')),
  created_at      TIMESTAMPTZ NOT NULL
);

-- ───────────── cross-chain bridge (NEAR Intents 1Click) ─────────────
CREATE TABLE bridge_transfers (
  id                  BIGSERIAL PRIMARY KEY,
  idempotency_key     TEXT NOT NULL UNIQUE,
  direction           TEXT NOT NULL CHECK (direction IN ('NEAR_TO_SOL','SOL_TO_NEAR')),
  status              TEXT NOT NULL CHECK (status IN ('quoted','submitting','deposited','processing','success','refunded','failed','expired')),
  amount_in           NUMERIC(78,0) NOT NULL,
  amount_out_expected NUMERIC(78,0),
  min_amount_out      NUMERIC(78,0),
  amount_out          NUMERIC(78,0),
  refunded_amount     NUMERIC(78,0),
  deposit_address     TEXT,
  deposit_memo        TEXT,
  quote               JSONB,
  quote_signature     TEXT,
  correlation_id      TEXT,
  deadline            TIMESTAMPTZ,
  origin_tx_hash      TEXT,
  signed_tx           TEXT,
  dest_tx_hashes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status_raw          JSONB,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL,
  settled_at          TIMESTAMPTZ
);
-- Only one bridge transfer per direction may be in flight.
CREATE UNIQUE INDEX bridge_one_in_flight ON bridge_transfers(direction) WHERE status IN ('quoted','submitting','deposited','processing');

-- ───────────── trading ─────────────
CREATE TABLE trading_positions (
  id                    BIGSERIAL PRIMARY KEY,
  mint                  TEXT NOT NULL,
  symbol                TEXT,
  name                  TEXT,
  pair_address          TEXT,
  dex_id                TEXT,
  exec_mode             TEXT NOT NULL CHECK (exec_mode IN ('simulated','paper','live')),
  status                TEXT NOT NULL CHECK (status IN ('opening','open','closing','closed','failed','written_off')),
  token_decimals        INT,
  tokens_bought         NUMERIC(78,0) NOT NULL DEFAULT 0,
  token_amount          NUMERIC(78,0) NOT NULL DEFAULT 0,
  cost_lamports         NUMERIC(78,0) NOT NULL DEFAULT 0,
  remaining_cost_lamports NUMERIC(78,0) NOT NULL DEFAULT 0,
  proceeds_lamports     NUMERIC(78,0) NOT NULL DEFAULT 0,
  fees_lamports         NUMERIC(78,0) NOT NULL DEFAULT 0,
  realized_pnl_lamports NUMERIC(78,0) NOT NULL DEFAULT 0,
  peak_value_lamports   NUMERIC(78,0) NOT NULL DEFAULT 0,
  last_value_lamports   NUMERIC(78,0),
  last_marked_at        TIMESTAMPTZ,
  take_profit_done      BOOLEAN NOT NULL DEFAULT false,
  entry_score           DOUBLE PRECISION,
  entry_signals         JSONB,
  exit_reason           TEXT,
  exit_attempts         INT NOT NULL DEFAULT 0,
  opened_at             TIMESTAMPTZ NOT NULL,
  closed_at             TIMESTAMPTZ
);
-- Never hold the same token twice at once.
CREATE UNIQUE INDEX positions_one_active_per_mint ON trading_positions(mint) WHERE status IN ('opening','open','closing');

CREATE TABLE trading_orders (
  id                      BIGSERIAL PRIMARY KEY,
  client_order_id         TEXT NOT NULL UNIQUE,
  position_id             BIGINT NOT NULL REFERENCES trading_positions(id),
  side                    TEXT NOT NULL CHECK (side IN ('buy','sell')),
  status                  TEXT NOT NULL CHECK (status IN ('planned','submitting','confirmed','failed','expired')),
  venue                   TEXT NOT NULL,
  amount_in               NUMERIC(78,0) NOT NULL,
  expected_out            NUMERIC(78,0),
  min_out                 NUMERIC(78,0),
  actual_in               NUMERIC(78,0),
  actual_out              NUMERIC(78,0),
  fee_lamports            NUMERIC(78,0),
  signature               TEXT UNIQUE,
  last_valid_block_height BIGINT,
  slippage_bps            INT,
  reason                  TEXT,
  quote                   JSONB,
  payload                 TEXT,
  error                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL,
  submitted_at            TIMESTAMPTZ,
  settled_at              TIMESTAMPTZ
);
CREATE INDEX trading_orders_open ON trading_orders(status) WHERE status IN ('planned','submitting');

-- Every on-chain transaction DEGEN sends or recognizes (public audit trail).
CREATE TABLE chain_transactions (
  id            BIGSERIAL PRIMARY KEY,
  chain         TEXT NOT NULL CHECK (chain IN ('near','solana')),
  hash          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  ref_type      TEXT,
  ref_id        TEXT,
  status        TEXT NOT NULL,
  simulated     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (chain, hash)
);

CREATE TABLE market_observations (
  id            BIGSERIAL PRIMARY KEY,
  mint          TEXT NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL,
  source        TEXT NOT NULL,
  data          JSONB NOT NULL,
  score         DOUBLE PRECISION,
  decision      TEXT,
  reasons       JSONB
);
CREATE INDEX market_observations_mint_time ON market_observations(mint, observed_at);
CREATE INDEX market_observations_time ON market_observations(observed_at);

-- ───────────── distribution ─────────────
CREATE TABLE holder_index (
  account_id       TEXT PRIMARY KEY,
  first_seen_block BIGINT,
  last_seen_block  BIGINT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE distribution_events (
  id                    BIGSERIAL PRIMARY KEY,
  idempotency_key       TEXT NOT NULL UNIQUE,
  pool_amount           NUMERIC(78,0) NOT NULL,
  allocated_amount      NUMERIC(78,0) NOT NULL,
  dust_amount           NUMERIC(78,0) NOT NULL,
  holder_count          INT NOT NULL,
  eligible_supply       NUMERIC(78,0) NOT NULL,
  snapshot_block_height BIGINT NOT NULL,
  snapshot_block_hash   TEXT NOT NULL,
  holder_source         TEXT NOT NULL,
  journal_id            BIGINT NOT NULL REFERENCES ledger_journals(id),
  created_at            TIMESTAMPTZ NOT NULL
);
CREATE TRIGGER distribution_events_append_only BEFORE UPDATE OR DELETE ON distribution_events FOR EACH ROW EXECUTE FUNCTION degen_forbid_mutation();

CREATE TABLE distribution_entitlements (
  id            BIGSERIAL PRIMARY KEY,
  event_id      BIGINT NOT NULL REFERENCES distribution_events(id),
  account_id    TEXT NOT NULL,
  balance       NUMERIC(78,0) NOT NULL,
  amount        NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  UNIQUE (event_id, account_id)
);
CREATE INDEX distribution_entitlements_account ON distribution_entitlements(account_id);
CREATE TRIGGER distribution_entitlements_append_only BEFORE UPDATE OR DELETE ON distribution_entitlements FOR EACH ROW EXECUTE FUNCTION degen_forbid_mutation();

CREATE TABLE reward_claims (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  account_id      TEXT NOT NULL,
  amount          NUMERIC(78,0) NOT NULL CHECK (amount > 0),
  status          TEXT NOT NULL CHECK (status IN ('pending','submitting','paid','failed','cancelled')),
  tx_hash         TEXT,
  signed_tx       TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  paid_at         TIMESTAMPTZ
);
-- One open claim per account at a time.
CREATE UNIQUE INDEX reward_claims_one_open ON reward_claims(account_id) WHERE status IN ('pending','submitting');

-- Each entitlement can be attached to exactly one claim, ever.
CREATE TABLE reward_claim_items (
  entitlement_id  BIGINT PRIMARY KEY REFERENCES distribution_entitlements(id),
  claim_id        BIGINT NOT NULL REFERENCES reward_claims(id)
);

-- ───────────── notifications outbox ─────────────
CREATE TABLE notifications (
  id            BIGSERIAL PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  text          TEXT NOT NULL,
  chat          TEXT NOT NULL DEFAULT 'group',
  sent_at       TIMESTAMPTZ,
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX notifications_unsent ON notifications(created_at) WHERE sent_at IS NULL;

-- Simulated chain state for DEGEN_ENV=development (never used in paper/live).
CREATE TABLE sim_near_balances (
  account_id    TEXT PRIMARY KEY,
  balance       NUMERIC(78,0) NOT NULL
);
CREATE TABLE sim_near_keys (
  account_id    TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  PRIMARY KEY (account_id, public_key)
);
