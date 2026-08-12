{
  secretAliases: (.metadata.annotations["run.googleapis.com/secrets"] // ""),
  containerSecretEnvs: [
    .spec.containers | to_entries[] as $container
    | $container.value.env[]?
    | select(.valueFrom.secretKeyRef)
    | {
        containerIndex: $container.key,
        containerName: ($container.value.name // ""),
        envName: .name,
        secretKeyRef: .valueFrom.secretKeyRef
      }
  ] | sort_by(.containerIndex, .envName),
  secretVolumes: [
    .spec.volumes[]?
    | select(.secret)
    | {name, secret: .secret}
  ] | sort_by(.name)
}
