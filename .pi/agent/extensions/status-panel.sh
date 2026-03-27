#!/bin/bash
# Pi status panel — runs in a cmux right split pane
# Shows modified files, git status, and session stats
# Auto-refreshes every 2 seconds, flicker-free
# Requires bash 4+ for associative arrays (brew install bash)

if [[ "${BASH_VERSINFO[0]}" -lt 4 ]]; then
  # Fall back to homebrew bash if available
  if [[ -x /opt/homebrew/bin/bash ]]; then
    exec /opt/homebrew/bin/bash "$0" "$@"
  elif [[ -x /usr/local/bin/bash ]]; then
    exec /usr/local/bin/bash "$0" "$@"
  else
    echo "Requires bash 4+ (brew install bash)"
    exit 1
  fi
fi

set -euo pipefail

# Colors
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'
GREEN='\033[32m'
YELLOW='\033[33m'
BLUE='\033[34m'
MAGENTA='\033[35m'
CYAN='\033[36m'
RED='\033[31m'
GRAY='\033[90m'

# Track session start
SESSION_START=$(date +%s)
STATS_FILE="${TMPDIR:-/tmp}/pi-status/session.json"

# Hide cursor during draws
tput civis 2>/dev/null || true
trap 'tput cnorm 2>/dev/null; clear; exit 0' INT TERM EXIT

draw() {
  local cols=$(tput cols)
  local rows=$(tput lines)
  local buf=""

  # Append a line to buffer, clear rest of line
  p() { buf+="$*"$'\033[K\n'; }
  # Horizontal rule
  hr() { local r; r=$(printf '%*s' "$cols" '' | tr ' ' '─'); p "${DIM}${r}${RESET}"; }

  # ── Header ──────────────────────────────────────────
  hr
  p " ${BOLD}Status${RESET}"
  hr

  # ── Git branch ──────────────────────────────────────
  local branch
  branch=$(git branch --show-current 2>/dev/null || echo "detached")
  local ahead=0 behind=0
  local ab
  ab=$(git rev-list --left-right --count "origin/${branch}...HEAD" 2>/dev/null) && {
    behind=$(echo "$ab" | cut -f1)
    ahead=$(echo "$ab" | cut -f2)
  }

  local bi="${branch}"
  [[ "$ahead" != "0" ]] && bi+=" ↑${ahead}"
  [[ "$behind" != "0" ]] && bi+=" ↓${behind}"
  p " ${CYAN}⎇${RESET} ${BOLD}${bi}${RESET}"

  # ── Session duration ────────────────────────────────
  local elapsed=$(( $(date +%s) - SESSION_START ))
  local mins=$((elapsed / 60)) secs=$((elapsed % 60))
  if [[ $mins -gt 0 ]]; then
    p " ${GRAY}⏱ ${mins}m${secs}s${RESET}"
  else
    p " ${GRAY}⏱ ${secs}s${RESET}"
  fi

  # ── Pi session info ─────────────────────────────────
  if [[ -f "$STATS_FILE" ]]; then
    local stats
    stats=$(cat "$STATS_FILE" 2>/dev/null)
    if [[ -n "$stats" ]]; then
      p ""
      hr
      p " ${BOLD}Session${RESET}"
      hr

      local model state ctx_pct ctx_tokens ctx_window
      model=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('model',''))" 2>/dev/null || true)
      state=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
      ctx_pct=$(echo "$stats" | python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('contextPercent'); print(f'{p:.0f}' if p is not None else '')" 2>/dev/null || true)

      # Model + state
      local state_icon state_color
      case "$state" in
        working) state_icon="●"; state_color="$YELLOW" ;;
        error)   state_icon="✗"; state_color="$RED" ;;
        *)       state_icon="○"; state_color="$GRAY" ;;
      esac
      [[ -n "$model" ]] && p " ${state_color}${state_icon}${RESET} ${BOLD}${model}${RESET}"

      # Context window bar
      if [[ -n "$ctx_pct" && "$ctx_pct" != "0" ]]; then
        local bar_width=$((cols - 16))
        local filled=$(( (${ctx_pct%.*} * bar_width) / 100 ))
        [[ $filled -gt $bar_width ]] && filled=$bar_width
        local empty=$((bar_width - filled))
        local bar_color="$GREEN"
        [[ ${ctx_pct%.*} -gt 70 ]] && bar_color="$YELLOW"
        [[ ${ctx_pct%.*} -gt 90 ]] && bar_color="$RED"
        local bar="${bar_color}$(printf '%*s' "$filled" '' | tr ' ' '█')${GRAY}$(printf '%*s' "$empty" '' | tr ' ' '░')${RESET}"
        p ""
        p " ${bar} ${ctx_pct}%"
        p ""
      fi

      # Token counts
      local in_tok out_tok cache_tok cost turns
      in_tok=$(echo "$stats" | python3 -c "import sys,json; v=json.load(sys.stdin).get('inputTokens',0); print(f'{v/1000:.1f}k' if v>=1000 else v)" 2>/dev/null || true)
      out_tok=$(echo "$stats" | python3 -c "import sys,json; v=json.load(sys.stdin).get('outputTokens',0); print(f'{v/1000:.1f}k' if v>=1000 else v)" 2>/dev/null || true)
      cache_tok=$(echo "$stats" | python3 -c "import sys,json; v=json.load(sys.stdin).get('cacheRead',0); print(f'{v/1000:.1f}k' if v>=1000 else v)" 2>/dev/null || true)
      cost=$(echo "$stats" | python3 -c "import sys,json; v=json.load(sys.stdin).get('cost',0); print(f'\${v:.4f}' if v>0 else '')" 2>/dev/null || true)
      turns=$(echo "$stats" | python3 -c "import sys,json; print(json.load(sys.stdin).get('turns',0))" 2>/dev/null || true)

      local tok_line=" ${GRAY}↑${in_tok} ↓${out_tok}"
      [[ "$cache_tok" != "0" ]] && tok_line+=" cache:${cache_tok}"
      [[ -n "$cost" ]] && tok_line+="  ${cost}"
      tok_line+="${RESET}"
      [[ "$turns" != "0" ]] && tok_line+="  ${turns} turn$([[ "$turns" != "1" ]] && echo 's')"
      p "$tok_line"
    fi
  fi

  # ── Modified files with +/- stats ──────────────────
  p ""
  hr
  p " ${BOLD}Files${RESET}"
  hr

  local file_count=0
  local max_files=$((rows - 20))
  [[ $max_files -lt 5 ]] && max_files=5
  local maxpath=$((cols - 24))

  short() {
    local f="$1"
    if [[ ${#f} -gt $maxpath ]]; then
      local name="${f##*/}"
      local dir="${f%/*}"
      local avail=$((maxpath - ${#name} - 4))
      if [[ $avail -gt 2 ]]; then
        echo "${dir:0:$avail}…/${name}"
      else
        echo "…${f: -$((maxpath - 1))}"
      fi
    else
      echo "$f"
    fi
  }

  # Get per-file diff stats into an associative array
  declare -A file_stats
  while IFS=$'\t' read -r adds dels sfile; do
    [[ -z "$sfile" ]] && continue
    file_stats["$sfile"]="${GREEN}+${adds}${RESET} ${RED}-${dels}${RESET}"
  done < <(git diff --numstat HEAD 2>/dev/null)

  # Stats for untracked files (line count)
  while IFS= read -r uf; do
    [[ -z "$uf" ]] && continue
    local lc
    lc=$(wc -l < "$uf" 2>/dev/null | tr -d ' ' || echo "0")
    file_stats["$uf"]="${GREEN}+${lc}${RESET}"
  done < <(git ls-files --others --exclude-standard 2>/dev/null)

  # Staged
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local st="${line%%$'\t'*}" f="${line#*$'\t'}" ic co lb
    case "$st" in
      A) ic="+"; co="$GREEN";  lb="staged" ;;
      M) ic="~"; co="$YELLOW"; lb="staged" ;;
      D) ic="-"; co="$RED";    lb="staged" ;;
      R) ic="→"; co="$BLUE";   lb="staged" ;;
      *) ic="?"; co="$GRAY";   lb="staged" ;;
    esac
    local ds="${file_stats[$f]:-}"
    [[ $file_count -lt $max_files ]] && p " ${co}${ic}${RESET} $(short "$f") ${ds} ${GRAY}${lb}${RESET}"
    file_count=$((file_count + 1))
  done < <(git diff --cached --name-status 2>/dev/null)

  # Unstaged
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local st="${line%%$'\t'*}" f="${line#*$'\t'}" ic co
    case "$st" in
      M) ic="~"; co="$YELLOW" ;; D) ic="-"; co="$RED" ;; *) ic="?"; co="$GRAY" ;;
    esac
    local ds="${file_stats[$f]:-}"
    [[ $file_count -lt $max_files ]] && p " ${co}${ic}${RESET} $(short "$f") ${ds}"
    file_count=$((file_count + 1))
  done < <(git diff --name-status 2>/dev/null)

  # Untracked
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    local ds="${file_stats[$f]:-}"
    [[ $file_count -lt $max_files ]] && p " ${GREEN}+${RESET} $(short "$f") ${ds}"
    file_count=$((file_count + 1))
  done < <(git ls-files --others --exclude-standard 2>/dev/null)

  if [[ $file_count -eq 0 ]]; then
    p " ${GRAY}No changes${RESET}"
  elif [[ $file_count -gt $max_files ]]; then
    p " ${GRAY}… +$((file_count - max_files)) more${RESET}"
  fi

  # ── Footer ──────────────────────────────────────────
  p ""
  hr
  p " ${GRAY}auto-refresh 2s • ctrl+c to close${RESET}"

  # Cursor home + buffer + clear below
  printf '\033[H%b\033[J' "$buf"
}

# ── Main loop ─────────────────────────────────────────

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo "Not a git repository"
  exit 1
fi

clear
while true; do
  draw
  sleep 2
done
