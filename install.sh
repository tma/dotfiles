#!/bin/bash
set -u

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

is_codespaces() {
  [ "${CODESPACES:-}" = "true" ] || [ -n "${CODESPACE_NAME:-}" ]
}

ensure_codespaces_node() {
  if command -v npm >/dev/null 2>&1; then
    return 0
  fi

  if ! is_codespaces; then
    return 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    warn "curl not available; cannot install Node.js for Codespaces"
    return 1
  fi

  if ! command -v sudo >/dev/null 2>&1 || ! command -v apt-get >/dev/null 2>&1; then
    warn "sudo or apt-get not available; cannot install Node.js for Codespaces"
    return 1
  fi

  log "Installing Node.js LTS for Codespaces..."
  if curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - \
    && sudo apt-get install -y nodejs; then
    hash -r
    return 0
  fi

  warn "Node.js install failed in Codespaces"
  return 1
}

link_dotfile() {
  local source_path="$1"
  local target_path="$2"

  if [ -d "$source_path" ]; then
    # If target is a directory symlink (from a previous run), remove it so we
    # can create a real directory and symlink individual files instead.
    if [ -L "$target_path" ]; then
      rm "$target_path"
      log "Removed old directory symlink $target_path"
    fi

    if ! mkdir -p "$target_path"; then
      warn "Failed to create directory $target_path"
      return 1
    fi

    for subitem in "$source_path"/*; do
      [ -e "$subitem" ] || continue
      local subname
      subname="$(basename "$subitem")"
      # Recurse into subdirectories so only files become symlinks.
      link_dotfile "$subitem" "$target_path/$subname"
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
  if ! is_codespaces; then
    if command -v opencode >/dev/null 2>&1; then
      log "OpenCode already available outside Codespaces; leaving existing install untouched"
    else
      log "Skipping OpenCode install outside Codespaces; manage OpenCode via Homebrew or manually"
    fi
    return 0
  fi

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

install_or_update_pi() {
  local npm_prefix="${NPM_CONFIG_PREFIX:-$HOME/.local}"

  if ! is_codespaces; then
    if command -v pi >/dev/null 2>&1; then
      log "pi already available outside Codespaces; leaving existing install untouched"
    else
      log "Skipping pi install outside Codespaces; manage pi via Homebrew or manually"
    fi
    return 0
  fi

  if ! command -v npm >/dev/null 2>&1; then
    if ! ensure_codespaces_node; then
      warn "npm not available; skipping pi install"
      return 0
    fi
  fi

  if ! mkdir -p "$npm_prefix/bin" "$npm_prefix/lib"; then
    warn "Failed to prepare npm prefix $npm_prefix; skipping pi install"
    return 0
  fi

  if command -v pi >/dev/null 2>&1; then
    log "Updating pi..."
  else
    log "Installing pi..."
  fi

  if NPM_CONFIG_PREFIX="$npm_prefix" npm install -g @mariozechner/pi-coding-agent; then
    hash -r
    return 0
  fi

  warn "pi install failed; continuing without blocking bootstrap"
  return 0
}

link_pi_agent() {
  # Pi stores transient state (auth.json, sessions/, bin/) alongside config
  # in ~/.pi/agent/. We symlink only the managed pieces individually so
  # transient files are left untouched.
  local pi_src="$DOTFILES_DIR/.pi/agent"
  local pi_dest="$HOME/.pi/agent"
  local failures=0

  if [ ! -d "$pi_src" ]; then
    return 0
  fi

  if ! mkdir -p "$pi_dest"; then
    warn "Failed to create $pi_dest"
    return 1
  fi

  for item in "$pi_src"/*; do
    [ -e "$item" ] || continue
    local name
    name="$(basename "$item")"
    if ln -sfn "$item" "$pi_dest/$name"; then
      log "Linked $pi_dest/$name -> $item"
    else
      warn "Failed to link $pi_dest/$name"
      failures=$((failures + 1))
    fi
  done

  return "$failures"
}

main() {
  local failures=0

  for file in "$DOTFILES_DIR"/.*; do
    local filename
    filename="$(basename "$file")"
    case "$filename" in
      .|..|.git|.gitignore|.gitmodules|.bashrc.local|.zshrc.local|.pi) continue ;;
    esac

    if ! link_dotfile "$file" "$HOME/$filename"; then
      failures=$((failures + 1))
    fi
  done

  if ! link_pi_agent; then
    failures=$((failures + 1))
  fi

  if ! ensure_local_shell_file "$HOME/.bashrc.local"; then
    failures=$((failures + 1))
  fi

  if ! ensure_local_shell_file "$HOME/.zshrc.local"; then
    failures=$((failures + 1))
  fi

  if ! install_or_update_opencode; then
    failures=$((failures + 1))
  fi

  if ! install_or_update_pi; then
    failures=$((failures + 1))
  fi

  if [ "$failures" -gt 0 ]; then
    warn "Dotfiles bootstrap completed with $failures non-fatal issue(s)"
  else
    log "Dotfiles installed successfully!"
  fi
}

main "$@"
