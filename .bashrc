if [ -f "$HOME/.shellrc" ]; then
  . "$HOME/.shellrc"
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
