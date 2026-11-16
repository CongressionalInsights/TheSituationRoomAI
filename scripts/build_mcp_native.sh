#!/usr/bin/env bash
# One create-only native build; invoked only inside an authorized manual workflow.
set -euo pipefail
umask 022
: "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${DIAG_DIR:?}" "${EXPECTED_SHA:?}"
test "$GITHUB_REF" = refs/heads/main
test "$EXPECTED_SHA" = "$GITHUB_SHA"
test "${SYNC_SECRET_VERSIONS:-}" = false
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API=false
node scripts/mcp_native_release.mjs manifest "$DIAG_DIR"
node scripts/mcp_native_release.mjs identity "$DIAG_DIR"
gcloud storage buckets describe gs://run-sources-situationroom-ai-20260112-us-central1 --raw --format=json --project "$PROJECT_ID" > "$DIAG_DIR/bucket.json"
gcloud artifacts repositories describe cloud-run-source-deploy --location "$REGION" --project "$PROJECT_ID" --format=json > "$DIAG_DIR/repository.json"
gcloud iam service-accounts describe 382918878290-compute@developer.gserviceaccount.com --project "$PROJECT_ID" --format=json > "$DIAG_DIR/build-account.json"
gcloud services list --enabled --filter='config.name:(cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com storage.googleapis.com containeranalysis.googleapis.com)' --project "$PROJECT_ID" --format=json > "$DIAG_DIR/apis.json"
node scripts/mcp_native_release.mjs preconditions "$DIAG_DIR"
node scripts/mcp_native_release.mjs archive "$DIAG_DIR"
SOURCE_URI=$(jq -er '.uri' "$DIAG_DIR/archive.json")
gcloud storage cp "$DIAG_DIR/source.tgz" "$SOURCE_URI" --if-generation-match=0 --project "$PROJECT_ID" > "$DIAG_DIR/upload.log" 2>&1
gcloud storage objects describe "$SOURCE_URI" --raw --format=json --project "$PROJECT_ID" > "$DIAG_DIR/source-object.json"
node scripts/mcp_native_release.mjs config "$DIAG_DIR"
gcloud builds submit --no-source --config "$DIAG_DIR/build-config.json" --region "$REGION" --project "$PROJECT_ID" --suppress-logs --format=json > "$DIAG_DIR/build-submitted.json"
BUILD_ID=$(jq -er '.id | select(test("^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$"))' "$DIAG_DIR/build-submitted.json")
gcloud builds describe "$BUILD_ID" --region "$REGION" --project "$PROJECT_ID" --format=json > "$DIAG_DIR/build.json"
node scripts/mcp_native_release.mjs image "$DIAG_DIR" > "$DIAG_DIR/immutable-image.txt"
