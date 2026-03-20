export LANG=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8

export EDITOR="zed"
export PATH="$HOME/.opencode/bin:$PATH"

# pi coding agent — extended prompt cache (Anthropic: 1h, OpenAI: 24h)
export PI_CACHE_RETENTION=long

if command -v gh >/dev/null 2>&1; then
fi

alias g="git"

autoload -Uz add-zsh-hook vcs_info
zstyle ':vcs_info:*' enable git
zstyle ':vcs_info:*' check-for-changes true
zstyle ':vcs_info:*' unstagedstr ' %F{red}[!]%f'
zstyle ':vcs_info:*' formats ' on %F{magenta} %b%f%u'
add-zsh-hook precmd vcs_info
setopt prompt_subst
PROMPT='%B%F{cyan}%1~%f${vcs_info_msg_0_}
%F{green}❯%f%b '

if [ -f "$HOME/.zshrc.local" ]; then
  . "$HOME/.zshrc.local"
fi
