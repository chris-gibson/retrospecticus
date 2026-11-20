#!/bin/sh
# Fails unless docs/releases/<tag>.md exists and is no longer the draft scripts/release.ts starts.
# Used by the pull request check (so a version bump cannot merge without notes) and by the release workflow.
set -eu
tag=$1
file="docs/releases/$tag.md"
if [ ! -s "$file" ]; then
  echo "Missing $file. Run bun scripts/release.ts ${tag#v} to start it, or write it by hand." >&2
  exit 1
fi
if grep -qF '<!-- draft:' "$file"; then
  echo "$file is still the draft: rewrite it for people upgrading and delete its draft line." >&2
  exit 1
fi
echo "Release notes for $tag: $file"
