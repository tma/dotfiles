#!/bin/bash
set -e

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# --- Install OpenCode ---
if ! command -v opencode &>/dev/null; then
  echo "Installing OpenCode..."
  curl -fsSL https://opencode.ai/install | bash
fi
export PATH="$HOME/.opencode/bin:$PATH"

# Append to shell rc files only if not already present
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  if ! grep -q '.opencode/bin' "$rc"; then
    echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> "$rc"
  fi
done

echo "Dotfiles installed successfully!"
