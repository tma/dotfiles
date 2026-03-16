export LANG=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8

export EDITOR="zed"
export PATH="$HOME/.opencode/bin:$PATH"

if command -v gh >/dev/null 2>&1; then
fi

alias g='git'

if command -v starship >/dev/null 2>&1; then
  eval "$(starship init bash)"
fi

if [ -f "$HOME/.bashrc.local" ]; then
  . "$HOME/.bashrc.local"
fi
