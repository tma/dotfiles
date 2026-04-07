export LANG=en_US.UTF-8
export LC_CTYPE=en_US.UTF-8

export EDITOR="zed"
export PATH="$HOME/.opencode/bin:$PATH"

if command -v gh >/dev/null 2>&1; then
fi

alias g='git'

__git_prompt() {
  local branch
  branch="$(git symbolic-ref --short HEAD 2>/dev/null)" || return
  local dirty=""
  git diff --quiet --ignore-submodules 2>/dev/null || dirty=" \033[31m[!]\033[0m"
  printf ' on \033[35m%s\033[0m%s' "$branch" "$dirty"
}
PS1='\[\033[1;36m\]\W\[\033[0m\]$(__git_prompt)\n\[\033[1;32m\]❯\[\033[0m\] '

if [ -f "$HOME/.bashrc.local" ]; then
  . "$HOME/.bashrc.local"
fi
