#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
script="$repository_root/infra/scripts/rerun-pr-checks.sh"
workflow="$repository_root/.github/workflows/rerun.yml"
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT

grep -Fq "github.event.comment.user.login == 'francotosqui'" "$workflow"
# The default is a literal assignment, not a value to expand in this test.
# shellcheck disable=SC2016
grep -Fq 'ALLOWED_USER=${ALLOWED_USER:-francotosqui}' "$script"
grep -Fq 'actions: write' "$workflow"
grep -Fq 'issues: write' "$workflow"
# Timeline comments on PRs also need the PR permission for the job token.
grep -Fq 'pull-requests: write' "$workflow"
grep -Fq '.github/workflows/publish.yml' "$script" && {
    printf '%s\n' 'Publish must not be in the rerun allowlist' >&2
    exit 1
}

fake_bin="$temporary_dir/bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${GH_LOG:?}"
url=""
for arg in "$@"; do
    case "$arg" in
        repos/*) url=$arg ;;
    esac
done
if [[ ${1:-} == api && $url == *"/pulls/"* && $url != *"/comments" ]]; then
    printf '%s\n' "${PR_JSON:?}"
    exit 0
fi
if [[ $url == *"/actions/runs?"* ]]; then
    printf '%s\n' "${RUNS_JSON:?}"
    exit 0
fi
if [[ $url == *"/rerun-failed-jobs" ]]; then
    if [[ -n ${RERUN_FAIL_ID:-} && $url == *"/runs/${RERUN_FAIL_ID}/"* ]]; then
        printf '%s\n' 'rerun rejected' >&2
        exit 1
    fi
    printf '%s\n' "$url" >> "${RERUN_LOG:?}"
    printf '%s\n' '{}'
    exit 0
fi
if [[ $url == *"/comments" && $* == *"--input -"* ]]; then
    cat >> "${COMMENT_LOG:?}"
    printf '\n' >> "${COMMENT_LOG:?}"
    printf '%s\n' '{"id":1}'
    exit 0
fi
printf 'unexpected gh invocation: %s\n' "$*" >&2
exit 1
EOF
chmod +x "$fake_bin/gh"

sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PR_JSON=$(jq -n --arg sha "$sha" '{user: {login: "francotosqui"}, head: {sha: $sha}}')
RUNS_JSON=$(jq -n --arg sha "$sha" '{
  workflow_runs: [
    {id: 1, name: "CI", path: ".github/workflows/ci.yml", status: "completed", conclusion: "failure", html_url: "https://github.com/mhbxyz/OpenWatchParty/actions/runs/1", run_number: 3, head_sha: $sha},
    {id: 2, name: "CI", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", html_url: "https://github.com/mhbxyz/OpenWatchParty/actions/runs/2", run_number: 4, head_sha: $sha},
    {id: 3, name: "E2E", path: ".github/workflows/e2e.yml", status: "completed", conclusion: "failure", html_url: "https://github.com/mhbxyz/OpenWatchParty/actions/runs/3", run_number: 8, head_sha: $sha},
    {id: 4, name: "Security", path: ".github/workflows/security.yml", status: "in_progress", conclusion: null, html_url: "https://github.com/mhbxyz/OpenWatchParty/actions/runs/4", run_number: 2, head_sha: $sha},
    {id: 5, name: "Publish", path: ".github/workflows/publish.yml", status: "completed", conclusion: "failure", html_url: "https://github.com/mhbxyz/OpenWatchParty/actions/runs/5", run_number: 9, head_sha: $sha},
    {id: 6, name: "Server Hardening", path: ".github/workflows/server-hardening.yml", status: "completed", conclusion: "timed_out", html_url: "https://github.com/mhbxyz/OpenWatchParty/actions/runs/6", run_number: 1, head_sha: $sha}
  ]
}')

run_case() {
    local name=$1
    shift
    local case_dir="$temporary_dir/$name"
    mkdir -p "$case_dir"
    env -u RERUN_FAIL_ID \
        PATH="$fake_bin:$PATH" \
        GH_LOG="$case_dir/gh.log" \
        RERUN_LOG="$case_dir/rerun.log" \
        COMMENT_LOG="$case_dir/comment.log" \
        PR_JSON="$PR_JSON" \
        RUNS_JSON="$RUNS_JSON" \
        REPO="mhbxyz/OpenWatchParty" \
        PR_NUMBER="221" \
        "$@" \
        "$script" >"$case_dir/stdout" 2>"$case_dir/stderr" || {
            printf '%s\n' "$case_dir/stdout" "$case_dir/stderr"
            cat "$case_dir/stdout" "$case_dir/stderr" >&2
            printf 'case %s failed\n' "$name" >&2
            exit 1
        }
    printf '%s\n' "$case_dir"
}

assert_file_contains() {
    local file=$1 needle=$2
    grep -Fq -- "$needle" "$file" || {
        printf 'missing %s in %s\n' "$needle" "$file" >&2
        cat "$file" >&2
        exit 1
    }
}

assert_file_excludes() {
    local file=$1 needle=$2
    if [[ -f $file ]] && grep -Fq -- "$needle" "$file"; then
        printf 'unexpected %s in %s\n' "$needle" "$file" >&2
        cat "$file" >&2
        exit 1
    fi
}

# Prose that merely mentions the command must not call GitHub.
prose=$(run_case prose \
    COMMENT_AUTHOR="francotosqui" \
    COMMENT_BODY="Could we add /rerun later?")
[[ ! -s $prose/gh.log ]]
[[ ! -s $prose/comment.log ]]

# Latest run per workflow wins. Publish is ignored. In-progress security is left alone.
main_case=$(run_case restart \
    COMMENT_AUTHOR="francotosqui" \
    COMMENT_BODY=$'/rerun\n')
assert_file_contains "$main_case/rerun.log" "repos/mhbxyz/OpenWatchParty/actions/runs/3/rerun-failed-jobs"
assert_file_contains "$main_case/rerun.log" "repos/mhbxyz/OpenWatchParty/actions/runs/6/rerun-failed-jobs"
assert_file_excludes "$main_case/rerun.log" "/runs/1/"
assert_file_excludes "$main_case/rerun.log" "/runs/2/"
assert_file_excludes "$main_case/rerun.log" "/runs/5/"
assert_file_contains "$main_case/comment.log" "https://github.com/mhbxyz/OpenWatchParty/actions/runs/3"
assert_file_contains "$main_case/comment.log" "Security is still running"
assert_file_contains "$main_case/comment.log" "CI already passed"
assert_file_excludes "$main_case/comment.log" "Publish"

filtered=$(run_case filtered \
    COMMENT_AUTHOR="francotosqui" \
    COMMENT_BODY="/rerun e2e.yml")
assert_file_contains "$filtered/rerun.log" "/runs/3/rerun-failed-jobs"
assert_file_excludes "$filtered/rerun.log" "/runs/6/"
assert_file_excludes "$filtered/comment.log" "Server Hardening"

missing=$(run_case missing \
    COMMENT_AUTHOR="francotosqui" \
    COMMENT_BODY="/rerun publish")
[[ ! -s $missing/rerun.log ]]
assert_file_contains "$missing/comment.log" "Nothing on the current commit matches \`publish\`"

other_author=$(run_case other-author \
    COMMENT_AUTHOR="francotosqui" \
    COMMENT_BODY="/rerun" \
    PR_JSON='{"user":{"login":"someoneelse"},"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}')
[[ ! -s $other_author/rerun.log ]]
assert_file_contains "$other_author/comment.log" "pull requests you opened"

outsider_dir="$temporary_dir/outsider"
mkdir -p "$outsider_dir"
if env PATH="$fake_bin:$PATH" \
    GH_LOG="$outsider_dir/gh.log" \
    RERUN_LOG="$outsider_dir/rerun.log" \
    COMMENT_LOG="$outsider_dir/comment.log" \
    PR_JSON="$PR_JSON" \
    RUNS_JSON="$RUNS_JSON" \
    REPO="mhbxyz/OpenWatchParty" \
    PR_NUMBER="221" \
    COMMENT_AUTHOR="someoneelse" \
    COMMENT_BODY="/rerun" \
    "$script" >"$outsider_dir/stdout" 2>"$outsider_dir/stderr"; then
    printf '%s\n' 'an outsider comment was accepted' >&2
    exit 1
fi
[[ ! -s $outsider_dir/gh.log ]]
[[ ! -s $outsider_dir/comment.log ]]

mkdir -p "$temporary_dir/api-error"
if env PATH="$fake_bin:$PATH" \
    GH_LOG="$temporary_dir/api-error/gh.log" \
    RERUN_LOG="$temporary_dir/api-error/rerun.log" \
    COMMENT_LOG="$temporary_dir/api-error/comment.log" \
    PR_JSON="$PR_JSON" \
    RUNS_JSON="$RUNS_JSON" \
    REPO="mhbxyz/OpenWatchParty" \
    PR_NUMBER="221" \
    COMMENT_AUTHOR="francotosqui" \
    COMMENT_BODY="/rerun e2e" \
    RERUN_FAIL_ID="3" \
    "$script" >"$temporary_dir/api-error/stdout" 2>"$temporary_dir/api-error/stderr"; then
    printf '%s\n' 'a rejected rerun was treated as success' >&2
    exit 1
fi
assert_file_contains "$temporary_dir/api-error/comment.log" "I could not restart some failed jobs"
assert_file_contains "$temporary_dir/api-error/comment.log" "rerun rejected"

printf '%s\n' 'rerun command checks passed'
