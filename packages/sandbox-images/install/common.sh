#!/usr/bin/env bash
set -euo pipefail
download_file() {
  local url="$1" destination="$2"
  local curl_args=(--fail --silent --show-error --location --retry 3 --retry-all-errors
    --connect-timeout 30 --max-time 300)
  printf 'Downloading %s\n' "$url"
  # File output lets curl discard partial bytes before retrying a transfer.
  # Retrying into a pipe can concatenate attempts and corrupt an archive.
  if curl "${curl_args[@]}" --output "$destination" "$url"; then
    return 0
  else
    local status=$?
    # GitHub's web download route can keep returning 504 even when its release
    # API is healthy. Resolve the same tag and filename, never a latest release.
    local release_pattern='^https://github\.com/([^/]+/[^/]+)/releases/download/(.+)/([^/?]+)$'
    if [[ "$url" =~ $release_pattern ]]; then
      local repository="${BASH_REMATCH[1]}" tag="${BASH_REMATCH[2]}" asset="${BASH_REMATCH[3]}"
      local encoded_tag asset_url metadata_file="${destination}.release.json"
      printf 'Retrying via GitHub release API: %s\n' "$url"
      if encoded_tag="$(jq -rn --arg tag "$tag" '$tag | @uri')" &&
        curl "${curl_args[@]}" --output "$metadata_file" "https://api.github.com/repos/$repository/releases/tags/$encoded_tag" &&
        asset_url="$(jq -er --arg name "$asset" '.assets | map(select(.name == $name)) | if length == 1 then .[0].url else error("release asset not found or ambiguous") end' "$metadata_file")" &&
        [[ "$asset_url" == "https://api.github.com/repos/$repository/releases/assets/"* ]] &&
        curl "${curl_args[@]}" --header 'Accept: application/octet-stream' --output "$destination" "$asset_url"; then
        rm -f "$metadata_file"
        return 0
      fi
      rm -f "$metadata_file"
    fi
    # Terraform retains only the tail of failed provisioner output.
    printf 'Download failed after retries: %s (curl exit %s)\n' "$url" "$status" >&2
    return "$status"
  fi
}

download_checked() {
  local url="$1" digest="$2" destination="$3"
  download_file "$url" "$destination"
  printf '%s  %s\n' "$digest" "$destination" | sha256sum --check -
}
