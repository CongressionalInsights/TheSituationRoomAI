#!/usr/bin/env bash
# Read-only ownership/configuration guard; never repairs state.
set -euo pipefail
: "${PROJECT_ID:?}" "${REGION:?}" "${SERVICE_NAME:?}"
DIAG_DIR=${DIAG_DIR:-/tmp/mcp-diagnostics}
gcloud run services describe "$SERVICE_NAME" --region "$REGION" --project "$PROJECT_ID" --format=json > "$DIAG_DIR/service-current.json"
gcloud run services get-iam-policy "$SERVICE_NAME" --region "$REGION" --project "$PROJECT_ID" --format=json > "$DIAG_DIR/iam-current.json"
node scripts/mcp_native_release.mjs state "$DIAG_DIR" "${1:?state phase}"
