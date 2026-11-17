import { feedBuild, releaseImage, nativeBuildConfig } from '../../../feed_native_build.mjs';

export function nativeBuildFixture() {
  const archive = { sourceSha: 'c'.repeat(40), contentSha256: 'd'.repeat(64), bucket: feedBuild.bucket,
    object: 'services/situation-room-feed/releases/gha-123-1/source.tgz', image: releaseImage('gha-123-1'),
    bytes: 42, md5: Buffer.alloc(16, 255).toString('base64'),
    sha256: Buffer.from(Array.from({ length: 32 }, (_, index) => index % 2 ? 255 : 251)).toString('base64') };
  archive.uri = `gs://${archive.bucket}/${archive.object}`;
  const object = { bucket: archive.bucket, name: archive.object, generation: '123', size: '42', md5Hash: archive.md5 };
  const config = nativeBuildConfig(archive, object);
  const build = { ...structuredClone(config), id: 'build-1', name: `projects/${feedBuild.projectNumber}/locations/${feedBuild.region}/builds/build-1`,
    projectId: feedBuild.project, status: 'SUCCESS', sourceProvenance: { resolvedStorageSource: config.source.storageSource,
      fileHashes: { [`${archive.uri}#123`]: { fileHash: [{ type: 'SHA256', value: archive.sha256 }] } } },
    results: { images: [{ name: archive.image, digest: 'sha256:' + 'a'.repeat(64) }] } };
  return { archive, object, config, build, submitted: { id: build.id }, tag: 'gha-123-1' };
}
