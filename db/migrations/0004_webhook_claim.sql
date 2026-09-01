-- ===========================================================================
-- Claim step for webhook_deliveries — see README Milestone 9
-- ===========================================================================
--
-- listDueDeliveries and updateDelivery used to be two separate transactions
-- with nothing claiming a row in between: two concurrent drain() sweeps —
-- whether from raising a BullMQ Worker's concurrency above 1 or from a
-- second worker process pointed at the same Redis — could both select the
-- same due delivery and both POST it. Receivers already have to tolerate
-- that in principle (fmos-idempotency-key is at-least-once delivery by
-- design), but it was wasted work, and it was the reason Milestone 7 fixed
-- the queue's own concurrency at 1 rather than exposing it as a knob.
--
-- claimed_at is that claim. listDueDeliveries now claims a row (SELECT ...
-- FOR UPDATE SKIP LOCKED, then UPDATE claimed_at, in one statement) in the
-- same transaction it selects it, so a second concurrent SELECT skips
-- whatever the first one is holding rather than reading it too. A crashed
-- worker that claimed a row and never called updateDelivery to finish it
-- would otherwise strand that row forever — claimed_at is a timestamp, not
-- a boolean, so a claim past PostgresStore's staleness window is treated as
-- expired and the row becomes selectable again. updateDelivery clears
-- claimed_at back to NULL whenever it records an outcome, so a delivery
-- scheduled for retry is immediately claimable again once next_attempt_at
-- arrives — it does not have to wait out the staleness window.

BEGIN;

ALTER TABLE webhook_deliveries
    ADD COLUMN claimed_at TIMESTAMPTZ;

-- webhook_deliveries_due_idx (next_attempt_at WHERE status = 'PENDING')
-- still drives the claim query's ORDER BY / LIMIT; this covers the added
-- claimed_at filter for the (hopefully rare) case where many rows are
-- concurrently claimed and being worked at once.
CREATE INDEX webhook_deliveries_claimed_idx ON webhook_deliveries (claimed_at)
    WHERE status = 'PENDING' AND claimed_at IS NOT NULL;

COMMIT;
