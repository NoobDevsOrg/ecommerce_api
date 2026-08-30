-- The Hero table already exists. Remove only the legacy one-default-per-tenant
-- partial unique index; Product-domain service logic now limits defaults to three.
DROP INDEX IF EXISTS public.uq_home_hero_default;
