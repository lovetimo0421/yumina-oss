/**
 * `plan_entitlements` started as an event-only table. Admin and referral
 * time-limited grants now share the overlay, so both fresh databases and
 * already-deployed databases must also accept paid membership gifts.
 */
export const PLAN_ENTITLEMENT_SOURCE_CHECK =
  "source IN ('event', 'admin', 'referral', 'gift')";

/**
 * Startup self-heal for databases created before admin/referral entitlements.
 *
 * The constraint definition check avoids taking an ALTER TABLE lock on every
 * boot once the database is current. The old and new constraints use the same
 * stable name, making this safe to run alongside the idempotent table setup.
 */
export const PLAN_ENTITLEMENT_SOURCE_CONSTRAINT_DDL = `DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'plan_entitlements'::regclass
      AND conname = 'plan_entitlements_source_check'
      AND (
        pg_get_constraintdef(oid) NOT LIKE '%admin%'
        OR pg_get_constraintdef(oid) NOT LIKE '%referral%'
        OR pg_get_constraintdef(oid) NOT LIKE '%gift%'
      )
  ) THEN
    ALTER TABLE plan_entitlements
      DROP CONSTRAINT plan_entitlements_source_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'plan_entitlements'::regclass
      AND conname = 'plan_entitlements_source_check'
  ) THEN
    ALTER TABLE plan_entitlements
      ADD CONSTRAINT plan_entitlements_source_check
      CHECK (${PLAN_ENTITLEMENT_SOURCE_CHECK});
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_entitlements' AND column_name = 'gift_credits'
  ) THEN
    ALTER TABLE plan_entitlements ADD COLUMN gift_credits INTEGER;
  END IF;
END $$`;
