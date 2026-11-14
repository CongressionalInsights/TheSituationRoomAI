#!/usr/bin/env bash
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
export CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API=false

: "${PROJECT_ID:?}" "${REGION:?}" "${SERVICE_NAME:?}" "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
test "$SERVICE_NAME" = situation-room-feed
test "$PROJECT_ID" = situationroom-ai-20260112
test "$REGION" = us-central1
test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ && "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
CANDIDATE_ONLY=${CANDIDATE_ONLY:?Select candidate-only or full release explicitly}
[[ "$CANDIDATE_ONLY" = true || "$CANDIDATE_ONLY" = false ]]
test "${SYNC_SECRET_VERSIONS:-}" = false
test "${GITHUB_REF:-}" = refs/heads/main
test "${EXPECTED_SHA:-}" = "$GITHUB_SHA"
DIAG_DIR=${DIAG_DIR:-/tmp/feed-diagnostics}
mkdir -p "$DIAG_DIR"
TAG="gha-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
CANDIDATE="${SERVICE_NAME}-${TAG}"
cp gcp/feed-proxy/build-manifest.json "$DIAG_DIR/manifest.json"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({candidate:process.argv[2],tag:process.argv[3],service:process.argv[4],buildMode:"native-source-v1"}))' \
  "$DIAG_DIR/release.json" "$CANDIDATE" "$TAG" "$SERVICE_NAME"
node scripts/feed_native_build.mjs identity "$DIAG_DIR"
cloud() { gcloud run "$@" --region "$REGION" --project "$PROJECT_ID"; }
snapshot() { cloud services describe "$SERVICE_NAME" --format=json > "$DIAG_DIR/service-current.json"; }
cloud services describe "$SERVICE_NAME" --format=json > "$DIAG_DIR/service-before.json"
ROLLBACK=$(jq -er -f scripts/cloud-run-serving-revision.jq "$DIAG_DIR/service-before.json")
jq -e '([.status.traffic[]? | select(.tag)] | length) == 0 and .metadata.generation == .status.observedGeneration' "$DIAG_DIR/service-before.json" >/dev/null
SERVICE_URL="https://situation-room-feed-382918878290.us-central1.run.app"
jq -e --arg url "$SERVICE_URL" '(.metadata.annotations["run.googleapis.com/urls"] | fromjson | index($url)) != null' "$DIAG_DIR/service-before.json" >/dev/null
cloud revisions describe "$ROLLBACK" --format=json > "$DIAG_DIR/revision-before.json"
jq -S -f scripts/cloud-run-secret-schema.jq "$DIAG_DIR/revision-before.json" > "$DIAG_DIR/secret-bindings-before.json"
PROMOTION_ATTEMPTED=false
ACCEPTED=false
CANDIDATE_ATTEMPTED=false

finish() {
  local result=$?
  trap - EXIT
  set +e
  snapshot
  local captured=$?
  if [ "$captured" != 0 ]; then exit 1; fi
  if [ "$CANDIDATE_ATTEMPTED" != true ]; then
    node scripts/verify_feed_release.mjs untouched "$DIAG_DIR" || result=1
    cp "$DIAG_DIR/service-current.json" "$DIAG_DIR/service-final.json"
    exit "$result"
  fi
  if [ "$CANDIDATE_ONLY" = true ]; then
    if ! node scripts/verify_candidate_only.mjs "$DIAG_DIR/service-before.json" "$DIAG_DIR/service-current.json" "$CANDIDATE" "$TAG" cleanup; then exit 1; fi
    if jq -e --arg tag "$TAG" 'any(.status.traffic[]?; .tag == $tag)' "$DIAG_DIR/service-current.json" >/dev/null; then
      cloud services update-traffic "$SERVICE_NAME" --remove-tags "$TAG" > "$DIAG_DIR/tag-cleanup.log" 2>&1 || result=1
    fi
    snapshot || result=1
    node scripts/verify_candidate_only.mjs "$DIAG_DIR/service-before.json" "$DIAG_DIR/service-current.json" "$CANDIDATE" "$TAG" cleaned || result=1
    cp "$DIAG_DIR/service-current.json" "$DIAG_DIR/service-final.json"
    exit "$result"
  fi
  if [ "$PROMOTION_ATTEMPTED" = true ] && [ "$ACCEPTED" != true ]; then
    if node scripts/verify_feed_release.mjs recover "$DIAG_DIR"; then
      cloud services update-traffic "$SERVICE_NAME" --to-revisions "${ROLLBACK}=100" > "$DIAG_DIR/rollback.log" 2>&1
      local restore=$?
      snapshot
      if [ "$restore" != 0 ] || ! node scripts/verify_feed_release.mjs restored "$DIAG_DIR"; then result=1; fi
    else
      echo 'Uncertain or unrelated resource change: refusing automatic rollback.' >&2
      result=1
    fi
  fi
  # Remove only our own tag, and only while the captured release still owns state.
  if node scripts/verify_feed_release.mjs recover "$DIAG_DIR"; then
    cloud services update-traffic "$SERVICE_NAME" --remove-tags "$TAG" > "$DIAG_DIR/tag-cleanup.log" 2>&1
    local cleanup=$?
    snapshot
    if [ "$cleanup" != 0 ]; then result=1; fi
    if [ "$ACCEPTED" = true ]; then
      node scripts/verify_feed_release.mjs cleaned "$DIAG_DIR" || result=1
    else
      jq -e --arg tag "$TAG" --arg revision "$ROLLBACK" \
        '([.status.traffic[]? | select(.tag == $tag)] | length) == 0 and ([.status.traffic[]? | select(.percent == 100) | .revisionName] == [$revision])' \
        "$DIAG_DIR/service-current.json" >/dev/null || result=1
    fi
  else
    echo 'Release tag cleanup requires owner reconciliation.' >&2
    result=1
  fi
  cp "$DIAG_DIR/service-current.json" "$DIAG_DIR/service-final.json"
  exit "$result"
}
trap finish EXIT

# Require existing native resources and identities; never create or enable a prerequisite.
SOURCE_BUCKET=run-sources-situationroom-ai-20260112-us-central1
BUILD_ACCOUNT=382918878290-compute@developer.gserviceaccount.com
gcloud storage buckets describe "gs://$SOURCE_BUCKET" --raw --format=json --project "$PROJECT_ID" > "$DIAG_DIR/bucket.json"
gcloud artifacts repositories describe cloud-run-source-deploy --location "$REGION" --project "$PROJECT_ID" --format=json > "$DIAG_DIR/repository.json"
gcloud iam service-accounts describe "$BUILD_ACCOUNT" --project "$PROJECT_ID" --format=json > "$DIAG_DIR/build-account.json"
gcloud services list --enabled --filter='config.name:(cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com storage.googleapis.com)' \
  --project "$PROJECT_ID" --format=json > "$DIAG_DIR/apis.json"
node scripts/feed_native_build.mjs preconditions "$DIAG_DIR"
node scripts/feed_native_build.mjs archive "$DIAG_DIR" "$GITHUB_SHA" "$TAG"
SOURCE_URI=$(jq -er '.uri' "$DIAG_DIR/archive.json")
gcloud storage cp "$DIAG_DIR/source.tgz" "$SOURCE_URI" --if-generation-match=0 --project "$PROJECT_ID" > "$DIAG_DIR/upload.log" 2>&1
gcloud storage objects describe "$SOURCE_URI" --raw --format=json --project "$PROJECT_ID" > "$DIAG_DIR/source-object.json"
node scripts/feed_native_build.mjs config "$DIAG_DIR"
# --no-source retains the config's explicit native storageSource; it does not fetch inside a step.
gcloud builds submit --no-source --config "$DIAG_DIR/build-config.json" --region "$REGION" --project "$PROJECT_ID" \
  --suppress-logs --format=json > "$DIAG_DIR/build-submitted.json"
BUILD_ID=$(jq -er '.id | select(test("^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$"))' "$DIAG_DIR/build-submitted.json")
gcloud builds describe "$BUILD_ID" --region "$REGION" --project "$PROJECT_ID" --format=json > "$DIAG_DIR/build.json"
IMAGE=$(node scripts/feed_native_build.mjs image "$DIAG_DIR")
snapshot
node scripts/verify_feed_release.mjs untouched "$DIAG_DIR"
# Image-only candidate deployment preserves captured secrets/public config/minima.
CANDIDATE_ATTEMPTED=true
cloud deploy "$SERVICE_NAME" --image "$IMAGE" --no-traffic \
  --revision-suffix "$TAG" --tag "$TAG" 2>&1 | tee "$DIAG_DIR/deploy.log"
cloud revisions describe "$CANDIDATE" --format=json > "$DIAG_DIR/revision-candidate.json"
snapshot
node scripts/verify_feed_release.mjs candidate "$DIAG_DIR"
cp "$DIAG_DIR/service-current.json" "$DIAG_DIR/service-candidate.json"
CANDIDATE_URL=$(jq -er --arg tag "$TAG" --arg revision "$CANDIDATE" '.status.traffic[] | select(.tag == $tag and .revisionName == $revision) | .url' "$DIAG_DIR/service-current.json")
curl --fail --silent --show-error --max-time 30 "${CANDIDATE_URL}/health/build" > "$DIAG_DIR/identity.json"
node scripts/verify_feed_release.mjs identity "$DIAG_DIR"
cp "$DIAG_DIR/identity.json" "$DIAG_DIR/identity-candidate.json"
node scripts/verify_feed_candidate.mjs "$CANDIDATE_URL" > "$DIAG_DIR/content-candidate.json"

snapshot
node scripts/verify_feed_release.mjs candidate "$DIAG_DIR"
cmp "$DIAG_DIR/service-candidate.json" "$DIAG_DIR/service-current.json"
if [ "$CANDIDATE_ONLY" = true ]; then
  node scripts/verify_money_candidate.mjs feed "$CANDIDATE_URL" > "$DIAG_DIR/money-candidate.json"
  snapshot
  node scripts/verify_feed_release.mjs candidate "$DIAG_DIR"
  exit 0
fi
PROMOTION_ATTEMPTED=true
cloud services update-traffic "$SERVICE_NAME" --to-revisions "${CANDIDATE}=100" > "$DIAG_DIR/promotion.log" 2>&1
snapshot
node scripts/verify_feed_release.mjs promoted "$DIAG_DIR"
cp "$DIAG_DIR/service-current.json" "$DIAG_DIR/service-promoted.json"
cloud revisions describe "$CANDIDATE" --format=json > "$DIAG_DIR/revision-canonical.json"
node scripts/verify_feed_release.mjs revision "$DIAG_DIR"
curl --fail --silent --show-error --max-time 30 "${SERVICE_URL}/health/build" > "$DIAG_DIR/identity.json"
node scripts/verify_feed_release.mjs identity "$DIAG_DIR"
cp "$DIAG_DIR/identity.json" "$DIAG_DIR/identity-canonical.json"
node scripts/verify_feed_candidate.mjs "$SERVICE_URL" > "$DIAG_DIR/content-canonical.json"
snapshot
node scripts/verify_feed_release.mjs promoted "$DIAG_DIR"
ACCEPTED=true
