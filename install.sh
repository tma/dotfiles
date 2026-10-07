#!/bin/bash
set -u

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"

# Only these items are deployed. Anything else in the checkout, such as .env,
# sessions, or build output, stays out of $HOME. Pi extension modules
# are linked whole, so their own node_modules and assets come along.
HOME_ITEMS=(.agents .bashrc .config .gemrc .gitconfig .shellrc .tmux.conf .zshrc)
PI_AGENT_ITEMS=(agents extensions models.json settings.json)
PI_LOCAL_ITEMS=(extensions models.json settings.json SYSTEM.md)

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

# Runtime entries ignored by .gitignore that can appear inside managed
# directories after a local install.
is_runtime_entry() {
  case "$(basename "$1")" in
    .env|node_modules|__pycache__|*.pyc|*.pyo|*.pyd) return 0 ;;
  esac
  return 1
}

is_managed_link() {
  local target_path="$1"
  local source_path="$2"

  [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$source_path" ]
}

# Link one path. Existing files, directories, and symlinks that point anywhere
# else are left alone and reported as failures.
link_path() {
  local source_path="$1"
  local target_path="$2"

  if is_managed_link "$target_path" "$source_path"; then
    log "Already linked $target_path"
    return 0
  fi

  if [ -e "$target_path" ] || [ -L "$target_path" ]; then
    warn "Skipping $target_path; it already exists and isn't linked to $source_path. Move it aside and rerun to link it."
    return 1
  fi

  if ln -s "$source_path" "$target_path"; then
    log "Linked $target_path -> $source_path"
  else
    warn "Failed to link $target_path"
    return 1
  fi
}

# Link every entry of source_dir, including hidden ones, into target_dir.
link_directory_entries() {
  local source_dir="$1"
  local target_dir="$2"
  local failures=0
  local item

  for item in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    is_runtime_entry "$item" && continue
    if ! link_dotfile "$item" "$target_dir/$(basename "$item")"; then
      failures=$((failures + 1))
    fi
  done

  [ "$failures" -eq 0 ]
}

# Directories become real directories with per-file links, so programs can keep
# their own runtime files next to the managed ones.
link_dotfile() {
  local source_path="$1"
  local target_path="$2"

  if [ -L "$source_path" ] || [ ! -d "$source_path" ]; then
    link_path "$source_path" "$target_path"
    return
  fi

  # Earlier installers linked whole directories. Replace only that exact link.
  if is_managed_link "$target_path" "$source_path"; then
    if ! rm "$target_path"; then
      warn "Failed to remove old directory symlink $target_path"
      return 1
    fi
    log "Removed old directory symlink $target_path"
  fi

  if [ -L "$target_path" ] || { [ -e "$target_path" ] && [ ! -d "$target_path" ]; }; then
    warn "Skipping $target_path; it already exists and isn't a directory. Move it aside and rerun to link it."
    return 1
  fi

  if ! mkdir -p "$target_path"; then
    warn "Failed to create directory $target_path"
    return 1
  fi

  link_directory_entries "$source_path" "$target_path"
}

link_items() {
  local linker="$1"
  local source_dir="$2"
  local target_dir="$3"
  local failures=0
  local name
  shift 3

  for name in "$@"; do
    if [ ! -e "$source_dir/$name" ]; then
      warn "Missing managed item $source_dir/$name"
      failures=$((failures + 1))
    elif ! "$linker" "$source_dir/$name" "$target_dir/$name"; then
      failures=$((failures + 1))
    fi
  done

  [ "$failures" -eq 0 ]
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

  if NPM_CONFIG_PREFIX="$npm_prefix" npm install -g @earendil-works/pi-coding-agent; then
    hash -r
    return 0
  fi

  warn "pi install failed; continuing without blocking bootstrap"
  return 0
}

# Pi loads a directory with one of these entry points as a single module that
# resolves its own node_modules and assets relative to itself.
is_extension_module() {
  [ -d "$1" ] && [ ! -L "$1" ] \
    && { [ -e "$1/index.ts" ] || [ -e "$1/index.js" ] || [ -e "$1/package.json" ]; }
}

# Merge into an existing extensions directory. Module directories are linked
# whole; a same-name directory that isn't our link is skipped, not merged.
link_extension_entries() {
  local source_dir="$1"
  local target_dir="$2"
  local failures=0
  local item

  for item in "$source_dir"/* "$source_dir"/.[!.]* "$source_dir"/..?*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    is_runtime_entry "$item" && continue
    if is_extension_module "$item"; then
      link_path "$item" "$target_dir/$(basename "$item")" || failures=$((failures + 1))
    else
      link_dotfile "$item" "$target_dir/$(basename "$item")" || failures=$((failures + 1))
    fi
  done

  [ "$failures" -eq 0 ]
}

# Pi profile directories are linked whole when missing. An existing real
# directory is merged so its other entries stay untouched.
link_pi_item() {
  local source_path="$1"
  local target_path="$2"

  if [ -d "$source_path" ] && [ -d "$target_path" ] && [ ! -L "$target_path" ]; then
    if [ "$(basename "$source_path")" = "extensions" ]; then
      link_extension_entries "$source_path" "$target_path"
    else
      link_dotfile "$source_path" "$target_path"
    fi
  else
    link_path "$source_path" "$target_path"
  fi
}

link_pi_profile() {
  # Pi stores transient state (auth.json, sessions/, bin/) alongside config.
  # Symlink only the managed pieces so those files stay out of the repository.
  local src="$1"
  local dest="$2"
  shift 2

  if ! mkdir -p "$dest"; then
    warn "Failed to create $dest"
    return 1
  fi

  link_items link_pi_item "$src" "$dest" "$@"
}

link_pi_agent() {
  local pi_src="$DOTFILES_DIR/.pi/agent"
  local pi_dest="$HOME/.pi/agent"
  local failures=0

  if [ -L "$pi_dest/skills" ]; then
    local old_skills_target
    old_skills_target="$(readlink "$pi_dest/skills" 2>/dev/null || true)"
    case "$old_skills_target" in
      "$DOTFILES_DIR/.pi/agent/skills"|"$DOTFILES_DIR/.agents/skills")
        rm "$pi_dest/skills"
        log "Removed stale $pi_dest/skills"
        ;;
    esac
  fi

  if ! link_pi_profile "$pi_src" "$pi_dest" "${PI_AGENT_ITEMS[@]}"; then
    failures=$((failures + 1))
  fi

  if ! link_path "$DOTFILES_DIR/.agents/AGENTS.md" "$pi_dest/AGENTS.md"; then
    failures=$((failures + 1))
  fi

  [ "$failures" -eq 0 ]
}

link_pi_local() {
  link_pi_profile "$DOTFILES_DIR/.pi/local" "$HOME/.pi/local" "${PI_LOCAL_ITEMS[@]}"
}

main() {
  local failures=0

  if ! link_items link_dotfile "$DOTFILES_DIR" "$HOME" "${HOME_ITEMS[@]}"; then
    failures=$((failures + 1))
  fi

  if ! link_pi_agent; then
    failures=$((failures + 1))
  fi

  if ! link_pi_local; then
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

  local gondolin_dir="$DOTFILES_DIR/.pi/agent/extensions/gondolin"
  if [ -f "$gondolin_dir/package.json" ] && command -v npm >/dev/null 2>&1; then
    log "Installing Gondolin extension dependencies..."
    if ! npm install --ignore-scripts --prefix "$gondolin_dir"; then
      warn "Gondolin npm install failed; host pi will run without the micro-VM"
    fi
  fi

  if [ "$failures" -gt 0 ]; then
    warn "Dotfiles bootstrap finished with $failures failed configuration step(s); see warnings above"
    return 1
  fi

  log "Dotfiles installed successfully!"
}

main "$@"
