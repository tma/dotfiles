export LANG=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8

export EDITOR="zed"
export PATH="$HOME/.opencode/bin:$PATH"

if command -v gh >/dev/null 2>&1; then
fi

alias g='git'

# In Codespaces, launch Pi inside tmux automatically unless we're already
# in tmux or not attached to a terminal.
if [ "${CODESPACES:-}" = "true" ] || [ -n "${CODESPACE_NAME:-}" ]; then
  pi() {
    if [ -n "${TMUX:-}" ] || ! command -v tmux >/dev/null 2>&1 || [ ! -t 0 ] || [ ! -t 1 ]; then
      command pi "$@"
      return
    fi

    local tmux_command="exec pi"
    local arg
    for arg in "$@"; do
      tmux_command="${tmux_command} $(printf '%q' "$arg")"
    done

    command tmux new-session -c "$PWD" "$tmux_command"
  }
fi

__git_prompt() {
  local branch
  branch="$(git symbolic-ref --short HEAD 2>/dev/null)" || return
  local dirty=""
  git diff --quiet --ignore-submodules 2>/dev/null || dirty=$' \001\033[31m\002[!]\001\033[0m\002'
  printf ' on \001\033[35m\002%s\001\033[0m\002%s' "$branch" "$dirty"
}
PS1='\[\033[1;36m\]\W\[\033[0m\]$(__git_prompt)\n\[\033[1;32m\]❯\[\033[0m\] '

if [ -f "$HOME/.bashrc.local" ]; then
  . "$HOME/.bashrc.local"
fi
