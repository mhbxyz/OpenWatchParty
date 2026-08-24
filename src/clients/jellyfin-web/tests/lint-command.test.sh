#!/bin/sh
set -eu

client_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
lint_fixture="$client_dir/tests/lint-invalid-fixture-$$.js"
syntax_fixture="$client_dir/tests/syntax-invalid-fixture-$$.js"
trap 'rm -f "$lint_fixture" "$syntax_fixture"' EXIT HUP INT TERM

printf '%s\n' 'missingLintGlobal = true;' > "$lint_fixture"

if (cd "$client_dir" && npm run lint -- --quiet >/dev/null 2>&1); then
  printf '%s\n' 'npm run lint unexpectedly accepted an invalid nested fixture' >&2
  exit 1
fi

rm -f "$lint_fixture"
printf '%s\n' 'const = ;' > "$syntax_fixture"

if (cd "$client_dir" && npm run check:syntax >/dev/null 2>&1); then
  printf '%s\n' 'npm run check:syntax unexpectedly accepted an invalid nested fixture' >&2
  exit 1
fi

rm -f "$syntax_fixture"
trap - EXIT HUP INT TERM

if [ -e "$lint_fixture" ] || [ -e "$syntax_fixture" ]; then
  printf '%s\n' 'lint or syntax fixture was not removed' >&2
  exit 1
fi
