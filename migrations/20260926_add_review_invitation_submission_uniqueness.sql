-- Phase A: one submitted review per guest review invitation.
-- Preflight on the approved non-production database found no duplicate
-- review_invitation_id values before this migration was authored.
-- This migration is additive and must be applied through the approved process.

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_reviews_review_invitation
  ON product_reviews (review_invitation_id);

-- Rollback (only after deploying code that no longer relies on this guard):
-- DROP INDEX IF EXISTS uq_product_reviews_review_invitation;
