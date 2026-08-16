#!/usr/bin/env bash
set -euo pipefail

# Script: create_release_v1.4.1.sh
# Purpose: Create annotated tag v1.4.1 and publish a GitHub Release pointing at the changelog-fix commit by default.
# Usage: Run this from a local clone of the repository (with push/release permissions).

REPO="kcmrshll9-ux/Safire"
TAG="v1.4.1"
TARGET_COMMIT="d4a85776e9a335776a51d7cc0e19aa3252ec39fd"  # changelog-fix commit
TITLE="$TAG"

read -r -d '' NOTES <<'EOF'
Changelog (v1.4.1)

- Clarified release note wording: "verified memory credentials" (fixed typo in original commit message: "credentia").

Security
- Hardened memory credential detection for underscore- and hyphen-delimited credential-like values, embedded compact JWTs, JWT punctuation boundaries, and bounded adversarial scan work.
- Added regression coverage for credential/JWT boundary handling in the memory schema and MCP ingress.
EOF

# Helpers
die () { echo "Error: $*" >&2; exit 1; }
info () { echo "[info] $*"; }

# Ensure we are in a git repo
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  die "This script must be run inside a local clone of the repository."
fi

# Ensure origin matches the intended repo
origin_url=$(git remote get-url origin 2>/dev/null || true)
if [[ -z "$origin_url" ]]; then
  die "No 'origin' remote found. Please add the remote and try again."
fi

if [[ "$origin_url" != *"kcmrshll9-ux/Safire"* ]]; then
  info "Warning: origin remote does not match 'kcmrshll9-ux/Safire'. Found: $origin_url"
  read -p "Continue anyway? [y/N] " yn
  case "$yn" in
    [Yy]*) ;;
    *) die "Aborted by user." ;;
  esac
fi

# Ensure target commit exists locally (fetch if needed)
if ! git cat-file -e ${TARGET_COMMIT}^{commit} 2>/dev/null; then
  info "Target commit $TARGET_COMMIT not present locally — fetching origin"
  git fetch origin
  if ! git cat-file -e ${TARGET_COMMIT}^{commit} 2>/dev/null; then
    die "Target commit $TARGET_COMMIT not found even after fetching."
  fi
fi

# If tag already exists remotely, exit
if git ls-remote --tags origin | grep -q "refs/tags/$TAG$"; then
  info "Tag $TAG already exists on origin. Skipping tag creation."
else
  info "Creating annotated tag $TAG -> $TARGET_COMMIT"
  git tag -a "$TAG" "$TARGET_COMMIT" -m "$TITLE"
  git push origin "$TAG"
fi

# Create GitHub Release: prefer gh if available
if command -v gh >/dev/null 2>&1; then
  info "Using GitHub CLI (gh) to create or update release."
  # gh release create will fail if the tag already has a release — use upload/replace
  if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    info "Release for $TAG already exists — updating notes."
    gh release edit "$TAG" --title "$TITLE" --notes "$NOTES" --repo "$REPO"
  else
    gh release create "$TAG" "$TARGET_COMMIT" --title "$TITLE" --notes "$NOTES" --repo "$REPO"
  fi
  info "Release published (via gh)."
  exit 0
fi

# Fallback: use GitHub API via curl. Requires GITHUB_TOKEN with repo scope.
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  info "GitHub CLI not found and GITHUB_TOKEN not set. To create the release manually, run the snippet below or install gh."
  echo
  echo "--- curl command (requires GITHUB_TOKEN) ---"
  cat <<CURL
curl -s -X POST \
  -H "Authorization: token \$GITHUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tag_name":"$TAG",
    "target_commitish":"$TARGET_COMMIT",
    "name":"$TITLE",
    "body":"$(echo "$NOTES" | python3 -c 'import sys, json; print(json.dumps(sys.stdin.read()))')",
    "draft":false,
    "prerelease":false
  }' \
  https://api.github.com/repos/$REPO/releases
CURL
  echo
  die "Please set GITHUB_TOKEN or install GitHub CLI (gh) and re-run the script."
fi

info "Creating/updating release via GitHub REST API."
# Check for existing release
existing=$(curl -s -H "Authorization: token $GITHUB_TOKEN" "https://api.github.com/repos/$REPO/releases/tags/$TAG")
if echo "$existing" | grep -q "Not Found"; then
  payload=$(cat <<JSON
{
  "tag_name":"$TAG",
  "target_commitish":"$TARGET_COMMIT",
  "name":"$TITLE",
  "body":$(python3 - <<PY
import json,sys
print(json.dumps("$NOTES"))
PY
),
  "draft":false,
  "prerelease":false
}
JSON
)
  curl -s -H "Authorization: token $GITHUB_TOKEN" -H "Content-Type: application/json" -d "$payload" "https://api.github.com/repos/$REPO/releases" | jq .
  info "Release created."
else
  info "Release for tag exists; updating its body."
  # Get release id
  release_id=$(echo "$existing" | python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])')
  payload=$(cat <<JSON
{
  "name":"$TITLE",
  "body":$(python3 - <<PY
import json,sys
print(json.dumps("$NOTES"))
PY
)
}
JSON
)
  curl -s -X PATCH -H "Authorization: token $GITHUB_TOKEN" -H "Content-Type: application/json" -d "$payload" "https://api.github.com/repos/$REPO/releases/$release_id" | jq .
  info "Release updated."
fi
