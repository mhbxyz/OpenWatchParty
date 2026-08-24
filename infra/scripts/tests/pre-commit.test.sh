#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT
repository="$temporary_dir/repository"
fake_bin="$temporary_dir/bin"
tool_log="$temporary_dir/tools.log"

mkdir -p \
    "$repository/.githooks" \
    "$repository/.github/workflows" \
    "$repository/infra/docker/dev" \
    "$repository/infra/docker/prod" \
    "$repository/infra/scripts" \
    "$repository/src/server/src" \
    "$repository/src/clients/jellyfin-web/node_modules/.bin" \
    "$fake_bin"
cp "$root/.githooks/pre-commit" "$repository/.githooks/pre-commit"
cp "$root/infra/scripts/scan-secrets.sh" "$repository/infra/scripts/scan-secrets.sh"

cat > "$repository/src/server/Cargo.toml" <<'EOF'
[package]
name = "hook-fixture"
version = "0.1.0"
edition = "2021"
EOF
printf 'fn main() {}\n' > "$repository/src/server/src/main.rs"
printf 'const valid = true;\n' > "$repository/src/clients/jellyfin-web/app.js"
printf 'export default [];\n' > "$repository/src/clients/jellyfin-web/eslint.config.js"
printf 'name: fixture\non: push\njobs: {}\n' > "$repository/.github/workflows/ci.yml"
printf 'services:\n  app:\n    image: scratch\n' > "$repository/infra/docker/dev/docker-compose.yml"
cp "$repository/infra/docker/dev/docker-compose.yml" "$repository/infra/docker/prod/docker-compose.yml"
printf 'title = "fixture"\n' > "$repository/.gitleaks.toml"
printf '{}\n' > "$repository/.gitleaks-baseline.json"

cat > "$fake_bin/cargo" <<'EOF'
#!/usr/bin/env bash
grep -q BAD_RUST src/main.rs && exit 1
printf 'cargo\n' >> "$OWP_HOOK_TOOL_LOG"
EOF
cat > "$fake_bin/node" <<'EOF'
#!/usr/bin/env bash
grep -q BAD_JS "${@: -1}" && exit 1
printf 'node\n' >> "$OWP_HOOK_TOOL_LOG"
EOF
cat > "$fake_bin/eslint" <<'EOF'
#!/usr/bin/env bash
for file in "$@"; do
    if [[ -f $file ]] && grep -q BAD_ESLINT "$file"; then exit 1; fi
done
printf 'eslint\n' >> "$OWP_HOOK_TOOL_LOG"
EOF
cat > "$fake_bin/actionlint" <<'EOF'
#!/usr/bin/env bash
for file in "$@"; do grep -q BAD_YAML "$file" && exit 1; done
printf 'actionlint\n' >> "$OWP_HOOK_TOOL_LOG"
EOF
cat > "$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
for argument in "$@"; do
    if [[ -f $argument ]] && grep -q BAD_COMPOSE "$argument"; then exit 1; fi
done
printf 'docker-compose\n' >> "$OWP_HOOK_TOOL_LOG"
EOF
cat > "$fake_bin/gitleaks" <<'EOF'
#!/usr/bin/env bash
git diff --cached --no-ext-diff -U0 | grep -q SECRET_TOKEN && exit 1
printf 'gitleaks\n' >> "$OWP_HOOK_TOOL_LOG"
EOF
chmod +x "$fake_bin"/* "$repository/.githooks/pre-commit" "$repository/infra/scripts/scan-secrets.sh"
ln -s "$fake_bin/eslint" "$repository/src/clients/jellyfin-web/node_modules/.bin/eslint"

git -C "$repository" init --quiet
git -C "$repository" config user.name 'Pre-commit Test'
git -C "$repository" config user.email 'pre-commit@example.invalid'
git -C "$repository" add --all
git -C "$repository" commit --quiet -m 'Initialize fixture'

run_hook() {
    (cd "$repository" && PATH="$fake_bin:$PATH" OWP_HOOK_TOOL_LOG="$tool_log" .githooks/pre-commit)
}

expect_failure() {
    local fixture=$1
    if run_hook >/dev/null 2>&1; then
        printf 'pre-commit accepted invalid %s fixture\n' "$fixture" >&2
        exit 1
    fi
    git -C "$repository" reset --hard --quiet HEAD
}

: > "$tool_log"
printf 'fn main() { }\n' > "$repository/src/server/src/main.rs"
printf 'const valid = false;\n' > "$repository/src/clients/jellyfin-web/app.js"
printf '# valid staged change\n' >> "$repository/.github/workflows/ci.yml"
printf '# valid staged change\n' >> "$repository/infra/docker/dev/docker-compose.yml"
git -C "$repository" add --all
printf 'BAD_RUST\n' >> "$repository/src/server/src/main.rs"
printf 'BAD_JS\n' >> "$repository/src/clients/jellyfin-web/app.js"
run_hook >/dev/null
for tool in cargo node eslint actionlint docker-compose gitleaks; do
    grep -q "^$tool$" "$tool_log" || {
        printf 'valid fixture did not invoke %s\n' "$tool" >&2
        exit 1
    }
done
git -C "$repository" reset --hard --quiet HEAD

printf 'BAD_RUST\n' >> "$repository/src/server/src/main.rs"
git -C "$repository" add src/server/src/main.rs
expect_failure Rust

printf 'BAD_JS\n' >> "$repository/src/clients/jellyfin-web/app.js"
git -C "$repository" add src/clients/jellyfin-web/app.js
expect_failure 'JavaScript syntax'

printf 'const BAD_ESLINT = true;\n' >> "$repository/src/clients/jellyfin-web/app.js"
git -C "$repository" add src/clients/jellyfin-web/app.js
expect_failure ESLint

printf 'BAD_YAML\n' >> "$repository/.github/workflows/ci.yml"
git -C "$repository" add .github/workflows/ci.yml
expect_failure YAML

printf 'SECRET_TOKEN=aB3dE5gH7jK9mN2pQ4sT6vW8yZ0cD1fG\n' > "$repository/leaked.txt"
git -C "$repository" add leaked.txt
expect_failure secret

printf 'pre-commit hook tests passed.\n'
