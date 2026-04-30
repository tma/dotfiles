if [ -f "$HOME/.shellrc" ]; then
  . "$HOME/.shellrc"
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
