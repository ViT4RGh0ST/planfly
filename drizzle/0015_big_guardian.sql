-- The interface language, per household.
--
-- In two statements, and the order is the whole point. The rows that already
-- exist belong to installations that were Spanish-only, so they get `es`: a
-- migration must not change what someone is already seeing. From here on, a new
-- household is born `en`, which is what whoever clones the repo needs.
--
-- One statement with `DEFAULT 'en'` would have made every existing household
-- English overnight. One with `DEFAULT 'es'` would have made every future one
-- Spanish. There is no single default that is right for both, so there are two.
ALTER TABLE "households" ADD COLUMN "locale" text DEFAULT 'es' NOT NULL;--> statement-breakpoint
ALTER TABLE "households" ALTER COLUMN "locale" SET DEFAULT 'en';
