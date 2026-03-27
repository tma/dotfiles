#!/bin/bash
# Opens all changed files in Zed's multi-diff view
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 1
cd "$root" || exit 1

args=()

# Modified files: diff HEAD version against working tree
while IFS=$'\t' read -r _ f; do
  [[ -z "$f" ]] && continue
  # Create HEAD version via process substitution doesn't work with zed
  # Use git worktree path trick: git show HEAD:file > tmp
  tmpfile=$(mktemp "/tmp/zed-diff-XXXXXX-$(basename "$f")")
  git show "HEAD:${f}" > "$tmpfile" 2>/dev/null || echo -n > "$tmpfile"
  args+=(--diff "$tmpfile" "${root}/${f}")
done < <(git diff --name-status HEAD 2>/dev/null)

if [[ ${#args[@]} -eq 0 ]]; then
  echo "No changes to diff"
  exit 0
fi

echo "Opening ${#args[@]} diff(s) in Zed"
zed "${args[@]}" 2>/dev/null

# Clean up temp files after Zed reads them
(sleep 5 && rm -f /tmp/zed-diff-* 2>/dev/null) &
