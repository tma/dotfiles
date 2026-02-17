export LANG=en_US.UTF-8
export LC_TYPE=en_US.UTF-8

export EDITOR="zed"

eval "$(starship init zsh)"

alias g="git"

mosht() {
  if [ -z "$1" ]; then
    echo "Usage: mosht hostname"
    return 1
  fi
  mosh "$1" -- tmux new -A -s default
}
