-- The ledger's invariants, saying what they say in English.
--
-- Nothing changes here: same checks, same triggers, same signatures. What
-- changes is the text of the six RAISE EXCEPTIONs, which is what somebody sees
-- in psql or in a server log when a write gets past the service layer and the
-- safety net catches it.
--
-- It goes as a new migration and not only as an edit to 0001 because 0001 has
-- already run everywhere it was going to run: a database created a year ago
-- would keep answering in Spanish for ever. `CREATE OR REPLACE FUNCTION` on the
-- existing name replaces the body without touching the triggers that point at
-- it, so nothing has to be dropped and nothing is locked beyond the statement.

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
--> statement-breakpoint
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
