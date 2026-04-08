#!/bin/bash
# Email Backfill — walks backwards through 24K+ sent items, 2000 per night
# Runs via launchd at 00:00 daily until backfill is complete

SCRIPT_DIR="$HOME/.claude/engram"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/email-backfill.log"

mkdir -p "$LOG_DIR"

source ~/.zshrc 2>/dev/null || true

echo "$(date): ========== Email backfill starting ==========" >> "$LOG_FILE"

cd "$SCRIPT_DIR"

# Restart Mail to clear any hung AppleScript state from prior runs
echo "$(date): Restarting Mail..." >> "$LOG_FILE"
osascript -e 'tell application "Mail" to quit' >> "$LOG_FILE" 2>&1
sleep 5
open -a Mail
sleep 10
echo "$(date): Mail restarted" >> "$LOG_FILE"

bun run sync-email.ts --backfill >> "$LOG_FILE" 2>&1
echo "$(date): Exit code: $?" >> "$LOG_FILE"

echo "$(date): ========== Email backfill complete ==========" >> "$LOG_FILE"

exit 0
