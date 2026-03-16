#!/bin/bash
set -u

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.opencode/bin:$PATH"

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

link_dotfile() {
  local source_path="$1"
  local target_path="$2"

  if [ -d "$source_path" ]; then
    if ! mkdir -p "$target_path"; then
      warn "Failed to create directory $target_path"
      return 1
    fi

    for subitem in "$source_path"/*; do
      [ -e "$subitem" ] || continue
      local subname
      subname="$(basename "$subitem")"
      if ln -sfn "$subitem" "$target_path/$subname"; then
        log "Linked $target_path/$subname -> $subitem"
      else
        warn "Failed to link $target_path/$subname"
      fi
    done
    return 0
  fi

  if ln -sfn "$source_path" "$target_path"; then
    log "Linked $target_path -> $source_path"
  else
    warn "Failed to link $target_path"
    return 1
  fi
}

ensure_local_shell_file() {
  local file="$1"

  if [ -L "$file" ]; then
    warn "Skipping managed symlink $file"
    return 0
  fi

  if [ -e "$file" ]; then
    return 0
  fi

  if printf '%s\n' '# Local shell overrides.' > "$file"; then
    log "Created $file"
  else
    warn "Failed to create $file"
    return 1
  fi
}

install_or_update_opencode() {
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not available; skipping OpenCode install"
    return 0
  fi

  if command -v opencode >/dev/null 2>&1; then
    log "Updating OpenCode..."
    if opencode upgrade; then
      return 0
    fi

    warn "OpenCode upgrade failed; continuing without blocking bootstrap"
    return 0
  fi

  log "Installing OpenCode..."
  if bash -lc 'curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path'; then
    return 0
  fi

  warn "OpenCode install failed; continuing without blocking bootstrap"
  return 0
}

install_starship_if_missing() {
  if command -v starship >/dev/null 2>&1; then
    log "Starship already installed"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not available; skipping Starship install"
    return 0
  fi

  log "Installing Starship..."
  if sh -c 'curl -fsSL https://starship.rs/install.sh | sh -s -- -y'; then
    return 0
  fi

  warn "Starship install failed; continuing without blocking bootstrap"
  return 0
}

main() {
  local failures=0

  for file in "$DOTFILES_DIR"/.*; do
    local filename
    filename="$(basename "$file")"
    case "$filename" in
      .|..|.git|.gitignore|.gitmodules|.bashrc.local|.zshrc.local) continue ;;
    esac

    if ! link_dotfile "$file" "$HOME/$filename"; then
      failures=$((failures + 1))
    fi
  done

  if ! ensure_local_shell_file "$HOME/.bashrc.local"; then
    failures=$((failures + 1))
  fi

  if ! ensure_local_shell_file "$HOME/.zshrc.local"; then
    failures=$((failures + 1))
  fi

  if ! install_or_update_opencode; then
    failures=$((failures + 1))
  fi

  if ! install_starship_if_missing; then
    failures=$((failures + 1))
  fi

  if [ "$failures" -gt 0 ]; then
    warn "Dotfiles bootstrap completed with $failures non-fatal issue(s)"
  else
    log "Dotfiles installed successfully!"
  fi
}

main "$@"
