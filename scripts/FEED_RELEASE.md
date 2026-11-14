# Feed Native-Source Release

This is the Feed-only release route. It does not change provider parsing, feed acceptance, fallback/freshness policy, application code or the MCP deployment route.

## Authority And Binding

Local fixtures and a reviewed candidate do not authorize a build or release. An authorized release uses `deploy-feed-proxy.yml` on `main`, with the exact reviewed `expected_sha`, an explicit `candidate_only` choice, and `sync_secret_versions:false`. Workflow, checkout and expected SHA must agree before authentication. There is no automatic retry or resource/access repair.

The November 14 attempt `43619954988/1` remains a failed historical attempt. Its independent source-generation gate was correct: the raw regional API response also lacked native source provenance. No success receipt or deployment allowance is restored by this change.

## Native Proof Chain

1. Capture the serving revision, service policy, configuration, secret references and traffic. Existing unrelated tags or unobserved state hold release.
2. Verify effective release credentials before cloud reads: require the existing auth action's service-account credential-file binding and metadata identity, and reject token overrides, token files, disabled credentials and impersonation. Never persist credential contents. Then require the existing build account, source bucket in `us-central1`, Docker artifact repository and exact enabled API names. Additional similarly named APIs do not invalidate complete required coverage. Read-only preflight does not prove every later permission. Both prompts and API enablement are disabled (`CLOUDSDK_CORE_SHOULD_PROMPT_TO_ENABLE_API=false`); some native enablement prompts default to yes, so suppressing prompts alone is insufficient.
3. Archive only the reviewed top-level Git files plus the generated packaged-source identity manifest. Untracked files, credentials, node_modules, symlinks and path traversal are not admitted. Verify Node `24.x`, each packaged file against the reviewed Git source, and the manifest before upload.
4. Upload one release-owned archive to the existing source bucket with generation-match zero. Read native object metadata and require exact bucket/object, generation, size and checksum. Build configuration takes its generation only from this metadata, not a Cloud Run source annotation.
5. Submit one native Cloud Build with an explicit `source.storageSource` and `--no-source` (which retains the config's native source field). Use the captured Google Node 24 builder digest via Cloud Build's standard pack step, `CLOUD_LOGGING_ONLY`, requested source SHA-256 and verified provenance. No Dockerfile, local Docker runtime or new installed dependency is added. The standard Google pack runner is an existing native build capability, not a promise of identical packaging; live candidate verification is still mandatory.
6. Independently read back the Build. Require submitted/readback ID, project/region, source input, resolved generation, archive SHA-256, build account, reviewed build settings and only the release-owned image destination/digest. Compare decoded hash bytes, accepting canonical REST/SDK base64 alphabets. A native untagged alias for the same repository/digest is allowed explicitly; other destinations or digests are rejected. Missing proof fails before any Cloud Run deployment. A successful Build status alone is insufficient.
7. Recheck captured service state, then deploy that immutable image with zero traffic. Stale source-build annotations on an image deployment are not evidence. Native Build/archive proof, the exact revision image and runtime `/health/build` bytes jointly bind the candidate.
8. Keep the existing candidate content checks, promotion guards, canonical identity/content checks, sentinel warning artifacts, rollback ownership and tag cleanup. Candidate-only mode never promotes. A pre-candidate failure verifies unchanged service state and does not run tag/traffic cleanup. Unrelated drift refuses recovery rather than overwriting it.

## Exact Existing Resources

- Project `situationroom-ai-20260112` (`382918878290`), region `us-central1`, service `situation-room-feed`.
- Release principal `gh-actions-deployer@situationroom-ai-20260112.iam.gserviceaccount.com`.
- Existing build account `382918878290-compute@developer.gserviceaccount.com`.
- Bucket `run-sources-situationroom-ai-20260112-us-central1`, object prefix `services/situation-room-feed/releases/gha-RUN-ATTEMPT/`.
- Existing repository `us-central1-docker.pkg.dev/situationroom-ai-20260112/cloud-run-source-deploy`, release-owned `situation-room-feed:gha-RUN-ATTEMPT` image.
- Builder `us-central1-docker.pkg.dev/serverless-runtimes/google-24-full/builder/universal@sha256:eed34031fd9ba4ecce8d844f7ef0b97ab06811649b64f4312853de8c82f3b981`, observed in both retained builds. Availability and compatibility are not newly cloud-qualified by offline tests.

## Limits And Recovery

Current resource access, `actAs`/build/upload/push permissions, pack-runner availability, verified-provenance support and packaging/runtime behavior must be established by an authorized attempt. This route may cost or take more than the former managed build; those effects are unmeasured. A denial is not authority to activate an API, retrieve credentials, change permissions, create a bucket/repository or substitute another account.

An uncertain upload/build/deploy effect must be reconciled from its retained diagnostics before any renewed attempt. The create-only source object and release-owned image identity are not deleted automatically. Before promotion, captured traffic remains serving; after an owned failed promotion, only the existing guarded rollback/tag procedure applies. No manual revision, build/image/archive, branch or checkout cleanup is included.

Run inert fixtures with inherited credentials cleared:

```sh
env -i PATH="$PATH" node --test scripts/test/feed-release.spec.mjs scripts/test/candidate-only.spec.mjs
```

The Feed fixtures invoke the actual shell helper against fake cloud/curl executables and include native-source rejection before candidate mutation. They do not validate live permissions, actual buildpack output or provider health. A new meaningful release diff receives the normal bounded review chain before integration. Production still requires an exact renewed approval, current-head CI, immutable candidate/readback proof and canonical acceptance; offline green is not release acceptance.

Native capability references: [Cloud Build storage source](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.builds#StorageSource), [build configuration and pack support](https://docs.cloud.google.com/sdk/gcloud/reference/builds/submit), [separate Cloud Build and image deployment](https://docs.cloud.google.com/run/docs/deploying-source-code#limitations).
