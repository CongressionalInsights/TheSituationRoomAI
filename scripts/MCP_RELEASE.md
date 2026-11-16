# MCP native source release

This changes release proof, not provider health policy. A reviewed local candidate
or passing fixtures does not authorize source publication, build or deployment.

A single approved manual run on main binds `expected_sha` to workflow and checkout
before authentication. `sync_secret_versions` must be false. Existing metadata-only
and CISA paths retain their original restrictions; neither substitutes for a normal
HMS release. The old metadata exception remains pinned to its original SHA.

The MCP adapter reuses Feed's native archive/build verifier with an explicit MCP
profile. Feed defaults stay unchanged. It archives only exact reviewed regular
Git files from `gcp/mcp-proxy`, plus the generated source identity manifest. It pins
Node 24.22.1, the existing Google builder digest, project, build account, source
bucket and artifact repository. It neither creates prerequisites nor enables APIs.
The source object uses a release-owned MCP prefix and generation-match-zero upload.
Object size/checksum/generation and the exact submitted Build's native resolved
source, archive hash, VERIFIED option, account, build settings and sole immutable
image destination must match before any deployment. A latest build or annotation
alone is never proof. Source object and image remain retained after the attempt.

Fresh snapshots capture the actual serving revision, traffic, exact optional
serving tag, full pod spec/environment/secret bindings, service configuration and
IAM policy. The existing service must already be public, min 1/max 20, with the
revision minimum zero. Image-only deployment sets no env, secret, timeout, scaling
or public-invocation flags. Full configuration/policy equality is checked before
build/deploy, at zero traffic, before promotion, on canonical verification and
cleanup. Dated baseline metadata does not replace these fresh guards.

The packaged MCP `/health/build` route rehashes the manifest's actual runtime files
and returns only source/content/service/revision identity, or an unverified error.
Candidate and canonical identity must match the native archive/build/image proof.
Existing health/discovery, SWPC content, candidate core sentinel, typed EIA/BLS
representation/availability gates, canonical content and exact traffic/tag gates
remain mandatory. `--allow-alerts` retains findings; it is not recovery acceptance.
FIRMS fallback/unknown times, BLS docs access and other warnings remain qualified.

At most one guarded traffic restoration may be attempted by the existing rollback
step. An exclusive rollback marker is created before that mutation. Unowned drift
refuses restoration/cleanup. Cleanup removes only the current smoke tag, plus an
explicitly approved old serving tag after successful canonical verification.
A nonzero deployment may still create a revision/tag. Its cleanup rechecks full
configuration/IAM, unchanged captured traffic and exact optional own-tag ownership
without requiring Ready status or a success-only candidate snapshot; uncertain or
unobserved state still refuses mutation. Candidate-only keeps captured traffic and
old tag. No revision/image/source object
or historical receipt is deleted, and no failed or uncertain action is replayed.

Existing resources: `situationroom-ai-20260112` / `us-central1`,
`situation-room-mcp`, build account
`382918878290-compute@developer.gserviceaccount.com`, source bucket
`run-sources-situationroom-ai-20260112-us-central1`, artifact repository
`cloud-run-source-deploy`, and the same builder/principal as the verified Feed
profile. Resource/identity checks are read-only and refuse missing or incompatible
state. Ordinary CI/build/storage/service/provider costs remain unmeasured.
