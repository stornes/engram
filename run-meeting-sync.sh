#!/bin/bash
# Engram Bidirectional Sync - runs via launchd at 05:00
# 1. PULL: Retrieve new external thoughts from Engram
# 2. PUSH: Back up Context (memory, skills, agents, hooks)
# 3. PUSH: Sync Slack messages, calendar events, session transcripts

SCRIPT_DIR="$HOME/.claude/engram"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/context-backup.log"

mkdir -p "$LOG_DIR" "$SCRIPT_DIR/state"

source ~/.zshrc 2>/dev/null || true

echo "$(date): ========== Starting Context backup ==========" >> "$LOG_FILE"

cd "$SCRIPT_DIR"

# 0. PULL: Retrieve new external thoughts from Engram (runs FIRST to avoid echo)
echo "$(date): --- pull-engram ---" >> "$LOG_FILE"
bun run pull-engram.ts >> "$LOG_FILE" 2>&1
echo "$(date): Exit code: $?" >> "$LOG_FILE"

# 1. PUSH: PAI file context (git diff-based)
echo "$(date): --- sync-pai-context ---" >> "$LOG_FILE"
bun run sync-pai-context.ts >> "$LOG_FILE" 2>&1
echo "$(date): Exit code: $?" >> "$LOG_FILE"

# 2. Slack messages
echo "$(date): --- sync-slack ---" >> "$LOG_FILE"
bun run sync-slack.ts >> "$LOG_FILE" 2>&1
echo "$(date): Exit code: $?" >> "$LOG_FILE"

# 3. Calendar events
echo "$(date): --- sync-calendar ---" >> "$LOG_FILE"
bun run sync-calendar.ts >> "$LOG_FILE" 2>&1
echo "$(date): Exit code: $?" >> "$LOG_FILE"

# 4. Session transcripts
echo "$(date): --- sync-sessions ---" >> "$LOG_FILE"
bun run sync-sessions.ts >> "$LOG_FILE" 2>&1
echo "$(date): Exit code: $?" >> "$LOG_FILE"

# 5. Email (relevant work emails from Apple Mail Exchange)
echo "$(date): --- sync-email ---" >> "$LOG_FILE"
bun run sync-email.ts >> "$LOG_FILE" 2>&1
echo "$(date): Exit code: $?" >> "$LOG_FILE"

echo "$(date): ========== Context backup complete ==========" >> "$LOG_FILE"

exit 0
