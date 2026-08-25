-- Hand-written migration: things Drizzle's DSL cannot express, and which are
-- precisely the ones holding up the ledger's correctness.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Fuzzy search by trigrams.
--    The bot sends NAMES ("provincial", "mercado"), not ids, so the model cannot
--    invent a foreign key. The trade-off is that the server has to resolve them,
--    and pg_trgm is what makes that matching cheap.
--    `unaccent` normalises "salud"/"salúd" and "veterinario"/"veterinário".
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE INDEX accounts_name_trgm_idx ON accounts USING gin (name gin_trgm_ops);
CREATE INDEX categories_name_trgm_idx ON categories USING gin (name gin_trgm_ops);
CREATE INDEX payees_name_trgm_idx ON payees USING gin (name gin_trgm_ops);

-- Aliases are searched too; a GIN over the array avoids scanning the table.
CREATE INDEX accounts_aliases_idx ON accounts USING gin (aliases);
CREATE INDEX categories_aliases_idx ON categories USING gin (aliases);
CREATE INDEX payees_aliases_idx ON payees USING gin (aliases);

-- `unaccent` is STABLE, not IMMUTABLE, so it cannot be indexed directly. This
-- immutable wrapper allows functional indexes over the accentless name, which is
-- exactly what resolve-entities.ts queries.
CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text AS
$$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT;

CREATE INDEX accounts_name_norm_idx ON accounts (lower(immutable_unaccent(name)));
CREATE INDEX categories_name_norm_idx ON categories (lower(immutable_unaccent(name)));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FK on transactions.import_batch_id.
--    It is not declared in the TS schema because imports.ts already imports
--    ledger.ts and doing it the other way would create a module cycle. The
--    constraint does have to exist.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE transactions
  ADD CONSTRAINT transactions_import_batch_fk
  FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The ledger's invariant, as a CONSTRAINT TRIGGER.
--
--    The rule is already enforced in recordTransaction(), which is the one write
--    path. This is the safety net: an import script, a hand correction in psql or
--    a future bug cannot be allowed to leave a transfer that does not balance.
--
--    DEFERRABLE INITIALLY DEFERRED is essential: the header and its lines are
--    inserted in the same transaction, so the state is invalid halfway through by
--    construction. It is validated at COMMIT.
--
--      expense    -> 1 line, negative
--      income     -> 1 line, positive
--      transfer   -> 2 lines, opposite signs, different accounts, no category
--      adjustment -> 1 line, any sign
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION validate_transaction() RETURNS TRIGGER AS $$
DECLARE
  v_kind          transaction_kind;
  v_voided        timestamptz;
  n_entries       integer;
  n_positive      integer;
  n_negative      integer;
  n_accounts      integer;
  n_categories    integer;
  v_transaction   uuid;
BEGIN
  IF TG_TABLE_NAME = 'transaction_entries' THEN
    v_transaction := COALESCE(NEW.transaction_id, OLD.transaction_id);
  ELSE
    v_transaction := COALESCE(NEW.id, OLD.id);
  END IF;

  SELECT kind, voided_at INTO v_kind, v_voided FROM transactions WHERE id = v_transaction;
  -- The header no longer exists: it was a cascading DELETE, nothing to validate.
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- A voided entry keeps its lines exactly as they were left.
  IF v_voided IS NOT NULL THEN RETURN NULL; END IF;

  SELECT count(*),
         count(*) FILTER (WHERE amount_minor > 0),
         count(*) FILTER (WHERE amount_minor < 0),
         count(DISTINCT account_id),
         count(*) FILTER (WHERE category_id IS NOT NULL)
    INTO n_entries, n_positive, n_negative, n_accounts, n_categories
    FROM transaction_entries WHERE transaction_id = v_transaction;

  IF v_kind = 'expense' THEN
    IF n_entries <> 1 OR n_negative <> 1 THEN
      RAISE EXCEPTION 'An expense needs exactly one negative line (entry %: % lines, % negative)',
        v_transaction, n_entries, n_negative;
    END IF;

  ELSIF v_kind = 'income' THEN
    IF n_entries <> 1 OR n_positive <> 1 THEN
      RAISE EXCEPTION 'An income needs exactly one positive line (entry %: % lines, % positive)',
        v_transaction, n_entries, n_positive;
    END IF;

  ELSIF v_kind = 'transfer' THEN
    IF n_entries <> 2 THEN
      RAISE EXCEPTION 'A transfer needs exactly two lines (entry % has %)', v_transaction, n_entries;
    END IF;
    IF n_positive <> 1 OR n_negative <> 1 THEN
      RAISE EXCEPTION 'A transfer needs one outgoing line and one incoming (entry %)', v_transaction;
    END IF;
    IF n_accounts <> 2 THEN
      RAISE EXCEPTION 'A transfer must move money between two different accounts (entry %)', v_transaction;
    END IF;
    -- Moving money between your own accounts is not an expense: with a category
    -- it would inflate the reports with money that never left the household.
    IF n_categories <> 0 THEN
      RAISE EXCEPTION 'The legs of a transfer carry no category (entry %)', v_transaction;
    END IF;

  ELSIF v_kind = 'adjustment' THEN
    IF n_entries <> 1 THEN
      RAISE EXCEPTION 'An adjustment needs exactly one line (entry % has %)', v_transaction, n_entries;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER transactions_validate
  AFTER INSERT OR UPDATE ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_transaction();

CREATE CONSTRAINT TRIGGER entries_validate
  AFTER INSERT OR UPDATE OR DELETE ON transaction_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_transaction();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. A line's currency must be its account's.
--    A USD line on a bolívar account would throw the balance out without
--    anything complaining.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION validate_entry_currency() RETURNS TRIGGER AS $$
DECLARE
  v_currency varchar(10);
BEGIN
  SELECT currency INTO v_currency FROM accounts WHERE id = NEW.account_id;
  IF v_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'The line is in % but account % carries %', NEW.currency, NEW.account_id, v_currency;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_currency_matches
  BEFORE INSERT OR UPDATE ON transaction_entries
  FOR EACH ROW EXECUTE FUNCTION validate_entry_currency();
