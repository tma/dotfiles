export LANG=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8

export EDITOR="zed"
export PATH="$HOME/.opencode/bin:$PATH"

# pi coding agent — extended prompt cache (Anthropic: 1h, OpenAI: 24h)
export PI_CACHE_RETENTION=long

if command -v gh >/dev/null 2>&1; then
fi

alias g="git"

if command -v starship >/dev/null 2>&1; then
  eval "$(starship init zsh)"
fi

if [ -f "$HOME/.zshrc.local" ]; then
  . "$HOME/.zshrc.local"
fi
