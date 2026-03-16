#!/bin/bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.opencode/bin:$PATH"

append_if_missing() {
  local file="$1"
  local line="$2"

  touch "$file"
  if ! grep -Fqx "$line" "$file"; then
    printf '%s\n' "$line" >> "$file"
  fi
}

# --- Symlink dotfiles ---
for file in "$DOTFILES_DIR"/.*; do
  filename="$(basename "$file")"
  case "$filename" in
    .|..|.git|.gitignore|.gitmodules) continue ;;
  esac

  target="$HOME/$filename"

  if [ -d "$file" ]; then
    mkdir -p "$target"
    for subitem in "$file"/*; do
      [ -e "$subitem" ] || continue
      subname="$(basename "$subitem")"
      ln -sfn "$subitem" "$target/$subname"
      echo "Linked $target/$subname -> $subitem"
    done
  else
    ln -sf "$file" "$target"
    echo "Linked $target -> $file"
  fi
done

# --- Install or update OpenCode ---
if command -v opencode >/dev/null 2>&1; then
  echo "Updating OpenCode..."
  opencode upgrade
else
  echo "Installing OpenCode..."
  curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path
fi

append_if_missing "$HOME/.bashrc" 'export PATH="$HOME/.opencode/bin:$PATH"'
append_if_missing "$HOME/.zshrc" 'export PATH="$HOME/.opencode/bin:$PATH"'

# --- Install Starship ---
if command -v curl >/dev/null 2>&1; then
  curl -fsSL https://starship.rs/install.sh | sh -s -- -y
fi

append_if_missing "$HOME/.bashrc" 'if command -v starship >/dev/null 2>&1; then eval "$(starship init bash)"; fi'
append_if_missing "$HOME/.zshrc" 'if command -v starship >/dev/null 2>&1; then eval "$(starship init zsh)"; fi'

echo "Dotfiles installed successfully!"
