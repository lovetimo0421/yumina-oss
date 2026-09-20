-- Ledger guard: every change to a wallet's balance must be explained by a
-- credit_transactions row (owner mandate 2026-09-19: "all mushies get recorded,
-- like blockchain").
--
-- A DEFERRED constraint trigger, checked at COMMIT for every UPDATE that changed
-- `balance`. It compares the wallet's balance as it stands at commit with the
-- newest ledger row's balance_after; a mismatch aborts the whole transaction, so
-- no code path — present, future, or an ad-hoc admin script — can move mushies
-- without writing them down. Judging the COMMITTED state (not the event's NEW
-- row) means a transaction that moves the balance several times (settle two
-- drops, then grant) is judged on its final row, which is what the ledger has
-- to match.
--
-- Holds (studio_credit_reservations) never touch `balance`, so they are outside
-- this rule by design; they withhold spendability, they do not move mushies.
--
-- Idempotent. Re-installed at every boot from SCHEDULED_FUNCTION_SCRIPTS
-- (packages/server/src/db/index.ts) and by the PGlite test fixture
-- (src/test/database-fixture.ts) so every integration test runs under it.
-- Apply by hand to dev, then prod, BEFORE deploying code that relies on it:
--   node packages/server/scripts/apply-sql.mjs packages/server/scripts/install-ledger-guard.sql

CREATE OR REPLACE FUNCTION credit_wallets_ledger_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  committed_balance double precision;
  latest_after      double precision;
  latest_at         timestamp;
BEGIN
  IF NEW.balance IS NOT DISTINCT FROM OLD.balance THEN
    RETURN NULL;
  END IF;

  SELECT balance INTO committed_balance FROM credit_wallets WHERE id = NEW.id;
  IF committed_balance IS NULL THEN
    RETURN NULL; -- wallet deleted later in the same transaction (account deletion)
  END IF;

  SELECT balance_after, created_at INTO latest_after, latest_at
    FROM credit_transactions
   WHERE wallet_id = NEW.id
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  -- balance and balance_after are float4: allow rounding noise, scaled for
  -- large wallets (float4 spacing is ~0.06 at 600k).
  IF latest_after IS NULL
     OR abs(latest_after - committed_balance) > (0.05 + abs(committed_balance) * 0.000002) THEN
    RAISE EXCEPTION 'LEDGER_GUARD: wallet % balance is % but the newest credit_transactions row says % (at %). Every mushie movement must write a ledger row in the same transaction.',
      NEW.id, committed_balance, latest_after, latest_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS credit_wallets_ledger_guard ON credit_wallets;
CREATE CONSTRAINT TRIGGER credit_wallets_ledger_guard
  AFTER UPDATE OF balance ON credit_wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION credit_wallets_ledger_guard();
