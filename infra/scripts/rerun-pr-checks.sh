#!/usr/bin/env bash
# Restart failed GitHub Actions jobs when an allowlisted author comments /rerun.
# The workflow on the default branch is the only caller. A pull request cannot
# change this script until it is merged.
set -euo pipefail

ALLOWED_USER=${ALLOWED_USER:-francotosqui}

usage() {
    printf '%s\n' 'Usage: COMMENT_BODY, COMMENT_AUTHOR, REPO, and PR_NUMBER must be set.' >&2
    exit 2
}

require_env() {
    [[ -n ${COMMENT_BODY+x} && -n ${COMMENT_AUTHOR:-} && -n ${REPO:-} && -n ${PR_NUMBER:-} ]] || usage
    [[ $COMMENT_AUTHOR =~ ^[A-Za-z0-9-]+$ ]] || usage
    [[ $ALLOWED_USER =~ ^[A-Za-z0-9-]+$ ]] || usage
    [[ $REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
    [[ $PR_NUMBER =~ ^[0-9]+$ ]] || usage
}

# Prints the optional workflow filter. Returns 1 when the comment is not a command.
parse_command() {
    local line
    while IFS= read -r line || [[ -n $line ]]; do
        line=${line%$'\r'}
        line=${line#"${line%%[![:space:]]*}"}
        line=${line%"${line##*[![:space:]]}"}
        if [[ $line == "/rerun" ]]; then
            printf '\n'
            return 0
        fi
        if [[ $line =~ ^/rerun[[:space:]]+([A-Za-z0-9_.-]+)$ ]]; then
            line=${BASH_REMATCH[1]}
            line=${line%.yml}
            line=${line%.yaml}
            printf '%s\n' "$line"
            return 0
        fi
    done <<< "$COMMENT_BODY"
    return 1
}

post_comment() {
    jq -n --arg body "$1" '{body: $body}' \
        | gh api --method POST "repos/${REPO}/issues/${PR_NUMBER}/comments" --input -
}

sanitize_error() {
    local text=$1
    text=${text//$'\n'/ }
    text=${text//$'\r'/ }
    printf '%s' "${text:0:240}"
}

collect_runs() {
    local page=1 body count combined='[]'
    while (( page <= 10 )); do
        body=$(gh api "repos/${REPO}/actions/runs?event=pull_request&head_sha=${head_sha}&per_page=100&page=${page}")
        count=$(jq -r '.workflow_runs | length' <<< "$body")
        [[ $count =~ ^[0-9]+$ ]] || {
            printf 'Workflow run list was not valid JSON\n' >&2
            exit 1
        }
        combined=$(jq -c --argjson page "$body" '. + $page.workflow_runs' <<< "$combined")
        if (( count < 100 )); then
            printf '%s\n' "$combined"
            return 0
        fi
        page=$((page + 1))
    done
    printf '%s\n' "$combined"
}

select_runs() {
    local filter=$1
    jq -c --arg filter "$filter" '
        def stem: .path | split("/") | last | sub("\\.(yml|yaml)$"; "");
        def allowed: (stem == "ci" or stem == "e2e" or stem == "security" or stem == "server-hardening");
        def wanted:
            ($filter | length) == 0
            or ((stem | ascii_downcase) == ($filter | ascii_downcase))
            or ((.name | ascii_downcase) == ($filter | ascii_downcase))
            or (
                ($filter | length) >= 3
                and ((.name | ascii_downcase) | contains($filter | ascii_downcase))
            );
        map(select(allowed))
        | group_by(.path)
        | map(max_by([.run_number, .id]))
        | map(select(wanted))
    ' <<< "$2"
}

skip_reason() {
    local status=$1 conclusion=$2
    if [[ $status != completed ]]; then
        printf '%s\n' 'is still running'
        return 0
    fi
    case $conclusion in
        success) printf '%s\n' 'already passed' ;;
        skipped | neutral) printf '%s\n' 'was skipped' ;;
        cancelled) printf '%s\n' 'was cancelled, so this command left it alone' ;;
        *) printf '%s\n' "finished with ${conclusion}" ;;
    esac
}

require_env

if [[ $COMMENT_AUTHOR != "$ALLOWED_USER" ]]; then
    printf 'Comment author %s is not allowlisted\n' "$COMMENT_AUTHOR" >&2
    exit 1
fi

if ! filter=$(parse_command); then
    exit 0
fi
filter=${filter%$'\n'}

pr_json=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}")
pr_author=$(jq -r '.user.login' <<< "$pr_json")
head_sha=$(jq -r '.head.sha' <<< "$pr_json")

if [[ $pr_author != "$ALLOWED_USER" ]]; then
    post_comment "\`/rerun\` only restarts checks on pull requests you opened." >/dev/null
    exit 0
fi

if [[ ! $head_sha =~ ^[0-9a-fA-F]{40}$ ]]; then
    printf 'Pull request head is not a commit SHA\n' >&2
    exit 1
fi

all_runs=$(collect_runs)
allowed_count=$(jq -r '
    def stem: .path | split("/") | last | sub("\\.(yml|yaml)$"; "");
    map(select(stem == "ci" or stem == "e2e" or stem == "security" or stem == "server-hardening"))
    | group_by(.path)
    | length
' <<< "$all_runs")
selected=$(select_runs "$filter" "$all_runs")

if [[ $selected == "[]" ]]; then
    if [[ -n $filter ]]; then
        post_comment "Nothing on the current commit matches \`${filter}\`. \`/rerun\` restarts failed jobs for CI, E2E, Security, and Server Hardening." >/dev/null
    elif [[ $allowed_count == 0 ]]; then
        post_comment "No checks on the current commit yet. \`/rerun\` only restarts runs that already exist for this commit." >/dev/null
    else
        post_comment 'No failed jobs on the current commit. Nothing to restart.' >/dev/null
    fi
    exit 0
fi

restarted=()
left_alone=()
errors=()
error_file=$(mktemp)
trap 'rm -f -- "$error_file"' EXIT

while IFS= read -r run; do
    id=$(jq -r '.id' <<< "$run")
    name=$(jq -r '.name' <<< "$run")
    status=$(jq -r '.status' <<< "$run")
    conclusion=$(jq -r '.conclusion // ""' <<< "$run")
    html_url=$(jq -r '.html_url // ""' <<< "$run")
    run_number=$(jq -r '.run_number' <<< "$run")

    [[ $id =~ ^[0-9]+$ && $run_number =~ ^[0-9]+$ ]] || {
        printf 'Workflow run identity was not numeric\n' >&2
        exit 1
    }
    [[ $name =~ ^[A-Za-z0-9_.[:space:]-]+$ ]] || name='workflow'

    if [[ $status == completed && ( $conclusion == failure || $conclusion == timed_out || $conclusion == startup_failure ) ]]; then
        if gh api --method POST "repos/${REPO}/actions/runs/${id}/rerun-failed-jobs" >/dev/null 2>"$error_file"; then
            if [[ $html_url =~ ^https://github.com/[^[:space:]]+$ ]]; then
                restarted+=("- [${name}](${html_url}) (run ${run_number})")
            else
                restarted+=("- ${name} (run ${run_number})")
            fi
        else
            errors+=("- ${name}: $(sanitize_error "$(cat "$error_file")")")
        fi
    else
        left_alone+=("- ${name} $(skip_reason "$status" "$conclusion")")
    fi
done < <(jq -c '.[]' <<< "$selected")

message=""
if (( ${#restarted[@]} > 0 )); then
    message="Restarted the failed jobs on the current commit:"
    printf -v restarted_block '%s\n' "${restarted[@]}"
    message+=$'\n\n'"${restarted_block%$'\n'}"
fi
if (( ${#errors[@]} > 0 )); then
    if [[ -n $message ]]; then
        message+=$'\n\n'
    fi
    message+="I could not restart some failed jobs:"
    printf -v error_block '%s\n' "${errors[@]}"
    message+=$'\n\n'"${error_block%$'\n'}"
fi
if (( ${#left_alone[@]} > 0 )); then
    if [[ -n $message ]]; then
        message+=$'\n\n'"Left these alone:"
    else
        message="No failed jobs on the current commit. Nothing to restart."
    fi
    printf -v left_block '%s\n' "${left_alone[@]}"
    message+=$'\n\n'"${left_block%$'\n'}"
fi
if [[ -z $message ]]; then
    message='No failed jobs on the current commit. Nothing to restart.'
fi

post_comment "$message" >/dev/null

if (( ${#errors[@]} > 0 )); then
    exit 1
fi
