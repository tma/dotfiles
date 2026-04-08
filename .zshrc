export LANG=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8

export EDITOR="zed"
export PATH="$HOME/.opencode/bin:$PATH"

# pi coding agent — extended prompt cache (Anthropic: 1h, OpenAI: 24h)
export PI_CACHE_RETENTION=long

if command -v gh >/dev/null 2>&1; then
fi

alias g="git"

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

autoload -Uz add-zsh-hook vcs_info
zstyle ':vcs_info:*' enable git
zstyle ':vcs_info:*' check-for-changes true
zstyle ':vcs_info:*' unstagedstr ' %F{red}[!]%f'
zstyle ':vcs_info:*' formats ' on %F{magenta}%b%f%u'
add-zsh-hook precmd vcs_info
setopt prompt_subst
PROMPT='%B%F{cyan}%1~%f${vcs_info_msg_0_}
%F{green}❯%f%b '

if [ -f "$HOME/.zshrc.local" ]; then
  . "$HOME/.zshrc.local"
fi
