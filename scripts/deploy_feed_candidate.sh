#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?}" "${REGION:?}" "${SERVICE_NAME:?}" "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
test "$SERVICE_NAME" = situation-room-feed
test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ && "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
DIAG_DIR=${DIAG_DIR:-/tmp/feed-diagnostics}
mkdir -p "$DIAG_DIR"
TAG="gha-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
CANDIDATE="${SERVICE_NAME}-${TAG}"
cp gcp/feed-proxy/build-manifest.json "$DIAG_DIR/manifest.json"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({candidate:process.argv[2],tag:process.argv[3],service:process.argv[4]}))' \
  "$DIAG_DIR/release.json" "$CANDIDATE" "$TAG" "$SERVICE_NAME"
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

finish() {
  local result=$?
  trap - EXIT
  set +e
  snapshot
  local captured=$?
  if [ "$captured" != 0 ]; then exit 1; fi
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

# Source deployment preserves all existing secret bindings, public config and minima.
cloud deploy "$SERVICE_NAME" --source gcp/feed-proxy --no-traffic \
  --revision-suffix "$TAG" --tag "$TAG" 2>&1 | tee "$DIAG_DIR/deploy.log"
cloud revisions describe "$CANDIDATE" --format=json > "$DIAG_DIR/revision-candidate.json"
snapshot
node scripts/verify_feed_release.mjs candidate "$DIAG_DIR"
cp "$DIAG_DIR/service-current.json" "$DIAG_DIR/service-candidate.json"
BUILD_ID=$(node scripts/verify_feed_release.mjs build-id "$DIAG_DIR")
gcloud builds describe "$BUILD_ID" --region "$REGION" --project "$PROJECT_ID" --format=json > "$DIAG_DIR/build.json"
CANDIDATE_URL=$(jq -er --arg tag "$TAG" --arg revision "$CANDIDATE" '.status.traffic[] | select(.tag == $tag and .revisionName == $revision) | .url' "$DIAG_DIR/service-current.json")
curl --fail --silent --show-error --max-time 30 "${CANDIDATE_URL}/health/build" > "$DIAG_DIR/identity.json"
node scripts/verify_feed_release.mjs identity "$DIAG_DIR"
cp "$DIAG_DIR/identity.json" "$DIAG_DIR/identity-candidate.json"
node scripts/verify_feed_candidate.mjs "$CANDIDATE_URL" > "$DIAG_DIR/content-candidate.json"

snapshot
node scripts/verify_feed_release.mjs candidate "$DIAG_DIR"
cmp "$DIAG_DIR/service-candidate.json" "$DIAG_DIR/service-current.json"
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
