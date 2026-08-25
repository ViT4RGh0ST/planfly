#!/usr/bin/env bash
#
# Backing up planfly's database.
#
# This is one person's production database: there is no replica, no managed
# provider and no way to rebuild a year of spending if the disk goes. A daily
# compressed dump is cheap — August's takes 86 KB — and it is the difference
# between losing a day and losing everything.
#
# It ALWAYS dumps the `planfly` database by name, never the environment's:
# during tests the app points at a clone, and a backup of the clone overwriting
# the good ones would be worse than having none.
#
# Cron runs it every hour, but it only dumps if the newest copy has already aged
# its hours: same idea as the recurrences' heartbeat — look at state and not at
# the clock — and it is what keeps a PC that was off all night from skipping the
# day's backup. As soon as you turn it on, the next hour it goes out.
#
#   ./scripts/backup-db.sh            # back up if due
#   FORCE=1 ./scripts/backup-db.sh    # right now, due or not
#   KEEP=60 ./scripts/backup-db.sh    # keep 60 instead of 30
#
set -euo pipefail

cd "$(dirname "$0")/.."

DB=planfly
DEST=backups
KEEP=${KEEP:-30}
# 20 and not 24: if yesterday's went out at 9:05, at exactly 24 h the 9:00 cron
# has not come round yet and the backup would drift an hour a day until it
# skipped one.
MIN_HOURS=${MIN_HOURS:-20}
STAMP=$(date +%Y%m%d-%H%M)
FILE="$DEST/$DB-$STAMP.sql.gz"

mkdir -p "$DEST"

if [ "${FORCE:-}" != "1" ]; then
  RECENT=$(find "$DEST" -name "$DB-*.sql.gz" -mmin -$((MIN_HOURS * 60)) -print -quit 2>/dev/null || true)
  if [ -n "$RECENT" ]; then
    exit 0
  fi
fi

# --clean --if-exists: the dump can be restored over a database that already
# exists without having to drop it by hand first, which is exactly what you do
# not want to be figuring out on the day you need it.
if ! docker compose exec -T db pg_dump -U planfly --clean --if-exists "$DB" | gzip -9 > "$FILE.partial"; then
  rm -f "$FILE.partial"
  echo "[backup] the dump of $DB FAILED" >&2
  exit 1
fi

# The file being there does not mean it is any good: a half-started container
# returns zero bytes with exit code 0. We check that it decompresses and that it
# carries the tables that matter BEFORE calling it good and rotating the old ones.
if ! gzip -t "$FILE.partial" 2>/dev/null; then
  rm -f "$FILE.partial"
  echo "[backup] FAILED: the file does not decompress" >&2
  exit 1
fi

# One single pass and no `grep -q`: exiting early makes grep close the pipe on
# zcat, zcat dies with 141 and `pipefail` marks as failed a backup that was
# perfect. Counting reads the whole file and closes nothing.
TABLES=$(zcat "$FILE.partial" | grep -c -E "^CREATE TABLE public\.(transactions|transaction_entries|accounts) ")
if [ "$TABLES" -lt 3 ]; then
  rm -f "$FILE.partial"
  echo "[backup] FAILED: the dump only carries $TABLES of the 3 tables that matter" >&2
  exit 1
fi

mv "$FILE.partial" "$FILE"

# Rotation: only after the new one is verified, so as not to end up with none by
# having deleted the oldest before checking the newest.
ls -1t "$DEST/$DB-"*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done

# The entry count is the signal that the dump carries data and not just the
# skeleton: if one day it comes out much lower than the previous, there is
# something to look at.
ENTRIES=$(docker compose exec -T db psql -U planfly -d "$DB" -tAc \
  "SELECT count(*) FROM transactions" 2>/dev/null || echo "?")

echo "[backup] $(date '+%F %H:%M') · $FILE · $(du -h "$FILE" | cut -f1) · $ENTRIES entries · $(ls -1 "$DEST/$DB-"*.sql.gz | wc -l) copies"
