#!/usr/bin/env bash
#
# migrate-issues.sh — copy labels + issues from the public source repo into a
# new target repo (e.g. when re-homing PsychPlotter into an org that a repo
# transfer can't reach). Code + history are moved separately (git push --mirror
# or GitHub's importer); this only handles the parts that don't live in git.
#
# Run it on a machine whose `gh` is authenticated to the TARGET org account.
# The source repo is public, so it can be read from any account.
#
# Requirements: gh (GitHub CLI, logged in) and jq.
# Usage:        ./migrate-issues.sh <target_owner/repo>
# Example:      ./migrate-issues.sh ARUP_ORG/PsychPlotter
#
# Notes / limitations (issues are not part of git, so this is a re-creation):
#   - Issue NUMBERS are reassigned by GitHub; each new issue notes its old number.
#   - Comments and original authors/timestamps are NOT copied (bodies are).
#   - Closed issues are re-created then closed.
#   - Safe to re-run only against an empty target — it does not de-duplicate.

set -euo pipefail

SRC="bbrannon4/PsychPlotter"
DST="${1:?Usage: ./migrate-issues.sh <target_owner/repo>   e.g. ARUP_ORG/PsychPlotter}"

command -v gh >/dev/null || { echo "error: gh (GitHub CLI) not found"; exit 1; }
command -v jq >/dev/null || { echo "error: jq not found"; exit 1; }

echo "Source: $SRC"
echo "Target: $DST"
echo

echo "==> Recreating labels"
gh label list --repo "$SRC" --limit 100 --json name,color,description \
  | jq -c '.[]' | while read -r l; do
    name=$(jq -r '.name' <<<"$l")
    color=$(jq -r '.color' <<<"$l")
    desc=$(jq -r '.description // ""' <<<"$l")
    gh label create "$name" --repo "$DST" --color "$color" --description "$desc" --force >/dev/null 2>&1 \
      && echo "   label: $name" || echo "   label exists/skipped: $name"
  done

echo
echo "==> Recreating issues (oldest first)"
gh issue list --repo "$SRC" --state all --limit 200 \
    --json number,title,body,labels,state \
  | jq -c 'sort_by(.number) | .[]' | while read -r i; do
    num=$(jq -r '.number' <<<"$i")
    title=$(jq -r '.title' <<<"$i")
    body=$(jq -r '.body // ""' <<<"$i")
    state=$(jq -r '.state' <<<"$i")
    labels=$(jq -r '[.labels[].name] | join(",")' <<<"$i")
    footer="_Migrated from ${SRC}#${num}._"

    url=$(gh issue create --repo "$DST" \
            --title "$title" \
            --body "$(printf '%s\n\n%s' "$body" "$footer")" \
            ${labels:+--label "$labels"})
    echo "   #$num ($state) -> $url"
    [ "$state" = "CLOSED" ] && gh issue close "$url" --repo "$DST" >/dev/null
  done

echo
echo "Done. Review the migrated issues in $DST."
