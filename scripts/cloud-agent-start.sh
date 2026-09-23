#!/usr/bin/env bash
# Cloud Agent environment "start" step for TBBT.
#
# Runs on every boot. The base snapshot already contains PostgreSQL and the
# migrated schema; this only reconciles the running daemon. Idempotent.
set -euo pipefail

PG_VERSION=16
PG_CLUSTER=main

if ! pg_lsclusters -h 2>/dev/null | awk '{print $4}' | grep -q online; then
  echo "[start] Starting PostgreSQL ${PG_VERSION}/${PG_CLUSTER}..."
  sudo pg_ctlcluster "${PG_VERSION}" "${PG_CLUSTER}" start || true
fi

for _ in $(seq 1 30); do
  if sudo -u postgres pg_isready -q; then
    echo "[start] PostgreSQL is ready."
    exit 0
  fi
  sleep 1
done

echo "[start] PostgreSQL did not become ready in time." >&2
exit 1
