-- Additive reconciliation fields for the existing PAYMENTS table. This file is
-- intentionally not executed by application startup or this change.
ALTER TABLE PAYMENTS
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_event_id text;

-- Provider identifiers are globally unique at Razorpay. These indexes prevent
-- a payment from being mapped to another Sagunthala order after reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_razorpay_order_id
  ON PAYMENTS(razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL AND is_deleted = false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_razorpay_payment_id
  ON PAYMENTS(razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL AND is_deleted = false;
