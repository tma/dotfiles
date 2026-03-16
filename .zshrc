export LANG=en_US.UTF-8
export LC_TYPE=en_US.UTF-8

export EDITOR="zed"


alias g="git"

if command -v starship >/dev/null 2>&1; then
  eval "$(starship init zsh)"
fi
