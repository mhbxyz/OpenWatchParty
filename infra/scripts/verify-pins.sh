#!/usr/bin/env bash
set -euo pipefail

repository_root=${REPOSITORY_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}
failures=0

report() {
    printf 'Pin verification failed: %s\n' "$*" >&2
    failures=$((failures + 1))
}

check_image() {
    local image=$1
    local context=$2
    case "$image" in
        openwatchparty/session-server:test|owp-session-server:scan) return ;;
    esac
    [[ $image =~ :[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || \
        report "$context image '$image' is not tag-and-digest pinned"
}

while IFS= read -r workflow; do
    while IFS= read -r entry; do
        line_number=${entry%%:*}
        line=${entry#*:}
        [[ $line =~ uses:[[:space:]]*([^[:space:]#]+) ]] || continue
        reference=${BASH_REMATCH[1]}

        # Repository-local actions do not cross a trust boundary.
        [[ $reference == ./* ]] && continue
        if [[ ! $reference =~ ^[^@]+@[0-9a-f]{40}$ ]]; then
            report "${workflow#"$repository_root/"}:$line_number uses '$reference' instead of a SHA40"
        fi
        if [[ $reference =~ @(master|v[0-9]+)$ ]]; then
            report "${workflow#"$repository_root/"}:$line_number uses mutable ref '$reference'"
        fi
    done < <(grep -nE '^[[:space:]-]*uses:[[:space:]]*' "$workflow" || true)
done < <(find "$repository_root/.github/workflows" -type f \( -name '*.yml' -o -name '*.yaml' \) -print)

while IFS= read -r dockerfile; do
    while IFS= read -r entry; do
        line_number=${entry%%:*}
        image=${entry#*:}
        image=${image#FROM }
        image=${image%% AS *}
        image=${image%% as *}

        # scratch is an empty, immutable Docker sentinel rather than a registry image.
        [[ $image == scratch ]] && continue
        [[ $image =~ :[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || \
            report "${dockerfile#"$repository_root/"}:$line_number FROM image '$image' is not tag-and-digest pinned"
    done < <(grep -nE '^FROM[[:space:]]+' "$dockerfile" || true)
done < <(find "$repository_root/infra/docker" -type f \( -name 'Dockerfile' -o -name '*.Dockerfile' \) -print)

compose_files=(
    "$repository_root/infra/docker/dev/docker-compose.yml"
    "$repository_root/infra/docker/prod/docker-compose.yml"
)
for compose_file in "${compose_files[@]}"; do
    while IFS= read -r entry; do
        line_number=${entry%%:*}
        image=${entry#*:}
        image=${image#*image: }

        # A dynamic Jellyfin tag is intentional because version.json drives it; its digest stays literal.
        [[ $image =~ :[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || \
            report "${compose_file#"$repository_root/"}:$line_number image '$image' is not tag-and-digest pinned"
    done < <(grep -nE '^[[:space:]]+image:[[:space:]]+' "$compose_file" || true)
done

while IFS= read -r entry; do
    file=${entry%%:*}
    remainder=${entry#*:}
    line_number=${remainder%%:*}
    image=${remainder#*:}
    image=${image% \\}

    check_image "$image" "${file#"$repository_root/"}:$line_number Docker"
done < <(grep -HnE '^[[:space:]@]+([a-z0-9.-]+(:[0-9]+)?/)?[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*:[^[:space:]]+[[:space:]]*\\?$' "$repository_root"/infra/just/*.just || true)

# Check standalone image tokens on continuation lines in Just and workflows, including Docker Hub.
while IFS= read -r file; do
    line_number=0
    while IFS= read -r line; do
        line_number=$((line_number + 1))
        candidate=${line#"${line%%[![:space:]@-]*}"}
        candidate=${candidate%%#*}
        candidate=${candidate%\\}
        candidate=${candidate%[[:space:]]}
        candidate=${candidate#\'}
        candidate=${candidate%\'}
        candidate=${candidate#\"}
        candidate=${candidate%\"}
        if [[ $candidate =~ ^([a-z0-9.-]+(:[0-9]+)?/)?[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)*:[^[:space:]]+$ ]]; then
            check_image "$candidate" "${file#"$repository_root/"}:$line_number"
        fi
    done < "$file"
done < <(find "$repository_root/infra/just" "$repository_root/.github/workflows" -type f \( -name '*.just' -o -name '*.yml' -o -name '*.yaml' \) -print)

((failures == 0)) || exit 1
printf 'All GitHub Actions and executable container images are immutably pinned.\n'
