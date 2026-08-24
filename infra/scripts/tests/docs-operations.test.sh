#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
installation="$repository_root/docs/operations/installation.md"
deployment="$repository_root/docs/operations/deployment.md"
packager="$repository_root/infra/scripts/package-plugin.sh"
version=$(jq -er '.version' "$repository_root/version.json")
archive="OpenWatchParty-v${version}.zip"
release_url="https://github.com/mhbxyz/OpenWatchParty/releases/download/v${version}/${archive}"
documented_archive_variable="\$archive"

require_literal() {
    local file=$1
    local literal=$2
    grep -Fq -- "$literal" "$file" || {
        printf 'Missing documented value in %s: %s\n' "${file#"$repository_root/"}" "$literal" >&2
        return 1
    }
}

reject_literal() {
    local file=$1
    local literal=$2
    if grep -Fq -- "$literal" "$file"; then
        printf 'Obsolete documented value in %s: %s\n' "${file#"$repository_root/"}" "$literal" >&2
        return 1
    fi
}

require_literal "$installation" "ghcr.io/mhbxyz/owp-session-server:v${version}"
require_literal "$installation" "$release_url"
require_literal "$installation" "unzip $archive"
require_literal "$installation" 'OpenWatchPartyPlugin.dll'
require_literal "$installation" 'https://mhbxyz.github.io/OpenWatchParty/jellyfin-plugin-repo/manifest.json'
require_literal "$installation" '-f infra/docker/server.Dockerfile'
require_literal "$installation" '-t owp-session-server ./src/server'
require_literal "$deployment" "$release_url"
require_literal "$deployment" './plugins/OpenWatchParty:/config/plugins/OpenWatchParty:ro'
require_literal "$deployment" "unzip \"$documented_archive_variable\" -d ./plugins/OpenWatchParty"
require_literal "$packager" "archive=\"\$output_dir/OpenWatchParty-v\${version}.zip\""
require_literal "$packager" "assembly=\"\$publish_dir/OpenWatchPartyPlugin.dll\""

reject_literal "$installation" 'docker build -t owp-session-server ./src/server'
reject_literal "$deployment" 'releases/latest/download/OpenWatchParty.dll'
reject_literal "$deployment" './plugins/OpenWatchParty.dll'

awk '
    function verify_command() {
        if (command ~ /owp-session-server/ && command !~ /JWT_SECRET/) {
            print "Session server command without JWT_SECRET:" command > "/dev/stderr"
            failed = 1
        }
        command = ""
        collecting = 0
    }
    /^docker run .*\\$/ {
        command = $0
        collecting = 1
        next
    }
    collecting {
        command = command "\n" $0
        if ($0 !~ /\\$/) {
            verify_command()
        }
    }
    END {
        if (collecting) {
            verify_command()
        }
        exit failed
    }
' "$installation"

for document in "$repository_root"/docs/operations/*.md; do
    while IFS= read -r markdown_link; do
        target=${markdown_link#*](}
        target=${target%)}
        target=${target%%#*}
        case "$target" in
            '' | http://* | https://* | mailto:*) continue ;;
        esac

        candidate="$(dirname -- "$document")/$target"
        if [[ ! -e $candidate && ! -e ${candidate}.md && ! -e $candidate/index.md ]]; then
            printf 'Broken local link in %s: %s\n' "${document#"$repository_root/"}" "$target" >&2
            exit 1
        fi
    done < <(grep -oE '\]\([^)]+\)' "$document" || true)
done

printf 'Operational documentation commands and links are consistent with version %s.\n' "$version"
