#!/bin/bash
set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.opencode/bin:$PATH"

link_dotfile() {
  local source_path="$1"
  local target_path="$2"

  if [ -d "$source_path" ]; then
    mkdir -p "$target_path"
    for subitem in "$source_path"/*; do
      [ -e "$subitem" ] || continue
      local subname
      subname="$(basename "$subitem")"
      ln -sfn "$subitem" "$target_path/$subname"
      echo "Linked $target_path/$subname -> $subitem"
    done
    return
  fi

  ln -sfn "$source_path" "$target_path"
  echo "Linked $target_path -> $source_path"
}

ensure_local_shell_file() {
  local file="$1"

  if [ ! -e "$file" ]; then
    printf '%s\n' '# Local shell overrides.' > "$file"
    echo "Created $file"
    return
  fi

  if [ -L "$file" ]; then
    echo "Skipping managed symlink $file"
  fi
}

# --- Symlink dotfiles ---
for file in "$DOTFILES_DIR"/.*; do
  filename="$(basename "$file")"
  case "$filename" in
    .|..|.git|.gitignore|.gitmodules|.bashrc.local|.zshrc.local) continue ;;
  esac

  link_dotfile "$file" "$HOME/$filename"
done

ensure_local_shell_file "$HOME/.bashrc.local"
ensure_local_shell_file "$HOME/.zshrc.local"

# --- Install or update OpenCode ---
if command -v opencode >/dev/null 2>&1; then
  echo "Updating OpenCode..."
  opencode upgrade
else
  echo "Installing OpenCode..."
  curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path
fi

# --- Install Starship when missing ---
if ! command -v starship >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
  curl -fsSL https://starship.rs/install.sh | sh -s -- -y
fi

echo "Dotfiles installed successfully!"
