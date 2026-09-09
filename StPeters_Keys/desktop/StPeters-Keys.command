#!/bin/bash
# =============================================================================
# StPeters-Keys.command — double-click this in Finder to run the newsletter.
#
# WHAT IT DOES, in order:
#   1. finds a Node.js of version 20 or newer, looking in the places Node
#      actually installs itself rather than trusting PATH alone (Finder gives a
#      double-clicked script a very short PATH, so `node` on its own is not
#      enough),
#   2. if there is none, explains in one sentence what is needed and why, ASKS
#      before installing anything, and then installs it with Homebrew if that
#      is present or the official installer package if it is not,
#   3. runs desktop/launch.js, which starts the server on 127.0.0.1 and opens
#      your browser,
#   4. if Node cannot be had — declined, or the install failed — opens
#      index.html straight from disk instead, and says what that costs.
#
# THE EXECUTABLE BIT. Finder will only run this if it is executable, and that
# permission does NOT survive a `git clone` on Windows or being emailed as a
# zip. If double-clicking opens this text in an editor instead of running it,
# open Terminal and run:
#     chmod +x "/path/to/StPeters-Keys.command"
#
# There is no `npm install` here and there never will be: this project has no
# packages. Node itself is the only thing it needs.
# =============================================================================

# Not `set -e`. Nearly every command below is a probe whose failure is a fact
# to act on, not a reason to abandon a person in front of a window that has
# just vanished. Failures are checked where they happen.
set -u

MIN_MAJOR=20

# Where are we? $0 may be relative, and Finder's working directory is not ours.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LAUNCH_JS="$HERE/launch.js"
INDEX_HTML="$ROOT/index.html"

NODE_BIN=""

rule() { printf '%s\n' "----------------------------------------------------------------"; }

# Terminal's default is to keep the window open, but that is a preference and
# not a guarantee, and a window that closes on the error message is the whole
# reason people hate scripts like this. So: always wait for a keypress before
# leaving, on every path.
pause_and_exit() {
  local code="${1:-0}"
  printf '\n'
  printf 'Press Return to close this window. '
  read -r _dummy || true
  exit "$code"
}

# ---------------------------------------------------------------------------
# Finding Node
#
# `node --version` prints e.g. "v20.11.1". Everything before the first dot
# after the v is the major, which is all that matters here.
# ---------------------------------------------------------------------------
node_major() {
  local candidate="$1"
  local out
  out="$("$candidate" --version 2>/dev/null)" || return 1
  case "$out" in
    v[0-9]*) printf '%s' "${out#v}" | cut -d. -f1 ;;
    *) return 1 ;;
  esac
}

usable() {
  local candidate="$1"
  [ -n "$candidate" ] || return 1
  [ -x "$candidate" ] || return 1
  local major
  major="$(node_major "$candidate")" || return 1
  [ -n "$major" ] || return 1
  [ "$major" -ge "$MIN_MAJOR" ] 2>/dev/null || return 1
  return 0
}

# Sets NODE_BIN, or leaves it empty. Order matters only in that a newer Node
# found later would still be fine; the first usable one wins.
find_node() {
  NODE_BIN=""

  local candidates=()

  # PATH first: if the person has a Node they chose, use that one.
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi

  # Homebrew on Apple silicon, Homebrew on Intel, the official .pkg (which
  # installs to /usr/local/bin), MacPorts, and the system location.
  candidates+=("/opt/homebrew/bin/node" "/usr/local/bin/node" \
               "/opt/local/bin/node" "/usr/bin/node")

  # nvm keeps every version it has ever installed here and puts none of them on
  # a PATH that Finder can see. A plain glob rather than a sorted list: any of
  # them that passes the version check will do, and usable() does the checking.
  if [ -d "$HOME/.nvm/versions/node" ]; then
    for nvm_dir in "$HOME/.nvm/versions/node"/v*; do
      [ -x "$nvm_dir/bin/node" ] && candidates+=("$nvm_dir/bin/node")
    done
  fi

  # fnm and Volta, both of which are also invisible to Finder.
  candidates+=("$HOME/.volta/bin/node" \
               "$HOME/Library/Application Support/fnm/aliases/default/bin/node")

  local c
  for c in "${candidates[@]}"; do
    if usable "$c"; then NODE_BIN="$c"; return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# The offline fallback
#
# Never leave somebody with a closed door. index.html works when opened
# straight from disk — that is a real, supported mode of this app — and the one
# thing it costs is worth saying plainly rather than burying.
# ---------------------------------------------------------------------------
open_from_disk() {
  printf '\n'
  rule
  printf '  Opening the newsletter straight from the file instead.\n'
  printf '\n'
  printf '  This works, and you can write, arrange and print exactly as usual.\n'
  printf '  What it costs: opened this way the page has no web address, and\n'
  printf '  some browsers (Safari especially) refuse to let a page like that\n'
  printf '  save anything. If that happens here, your work will NOT be kept\n'
  printf '  when you close the tab, so use "Save a copy" / print to PDF as you\n'
  printf '  go, or install Node.js and run this launcher again.\n'
  rule
  printf '\n'
  open "$INDEX_HTML" 2>/dev/null || {
    printf 'Could not open it automatically. Open this file in your browser:\n'
    printf '  %s\n' "$INDEX_HTML"
  }
}

# ---------------------------------------------------------------------------
# Installing Node, with consent
# ---------------------------------------------------------------------------

# Returns 0 for yes. Anything that is not a clear yes is a no: this installs
# software, and a stray keypress must not be read as permission.
ask_consent() {
  printf '\n'
  rule
  printf '  St. Peter'"'"'s Keys needs Node.js (version %s or newer) to run on\n' "$MIN_MAJOR"
  printf '  your Mac. It is the free, standard program that runs the small\n'
  printf '  local server this app uses to hold your newsletter safely while\n'
  printf '  you edit it. Nothing is sent anywhere.\n'
  rule
  printf '\n'
  printf 'Install Node.js now? [y/N] '
  local answer=""
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

install_with_homebrew() {
  printf '\n[keys] Installing Node.js with Homebrew. This takes a few minutes.\n\n'
  brew install node
  return $?
}

# The official installer package, for a Mac with no Homebrew.
#
# The version is NOT hard-coded: a pinned URL is a 404 waiting to happen, and a
# 404 here reads to the user as "this app is broken". The current LTS filename
# is read out of the directory listing Node publishes, which has been stable
# for a decade. If anything in that chain fails we stop and hand over to the
# person, rather than guessing.
install_with_pkg() {
  local pkg_name url tmp
  # The macOS .pkg is a universal installer — one file for Apple silicon and
  # Intel alike, with no architecture in its name — so nothing here needs to
  # know which Mac this is. The check stays anyway: on some third thing we have
  # never seen, stopping with a clear sentence beats downloading an installer
  # that cannot run.
  case "$(uname -m)" in
    arm64|x86_64) ;;
    *) printf '[keys] Unrecognised Mac processor (%s).\n' "$(uname -m)"; return 1 ;;
  esac

  # Which Node to install is asked of nodejs.org, not written down here.
  #
  # An earlier version of this script fetched /dist/latest-v22.x/. That is a
  # hard-coded major line dressed up as a lookup: it silently installs an
  # ageing LTS long after a newer one exists, and turns into a 404 — which
  # reads to the user as "this app is broken" — the day v22 is removed. A
  # parish is expected to run this for years without anybody editing it.
  #
  # /dist/index.tab is a tab-separated table, newest release first, with an
  # "lts" column that holds the codename for LTS releases and "-" for the
  # rest. So: find the lts column by NAME (never by position — columns have
  # been added to this file before), then take the first row that has one.
  # /dist/latest-lts/ would be the obvious thing to use and does not exist.
  local version
  printf '\n[keys] Asking nodejs.org which release is current…\n'
  version="$(curl -fsSL --max-time 30 "https://nodejs.org/dist/index.tab" 2>/dev/null \
    | awk -F'\t' 'NR==1 { for (i=1; i<=NF; i++) if ($i=="lts") col=i; next }
                  col && $col != "-" { print $1; exit }')"

  case "$version" in
    v[0-9]*) ;;
    *)
      printf '[keys] Could not reach nodejs.org to find the installer.\n'
      return 1
      ;;
  esac

  pkg_name="node-$version.pkg"
  url="https://nodejs.org/dist/$version/$pkg_name"

  tmp="$(mktemp -d -t stpeters-keys-node)" || return 1
  printf '[keys] Downloading %s\n' "$url"
  if ! curl -fL --max-time 900 -o "$tmp/node.pkg" "$url"; then
    printf '[keys] The download failed.\n'
    rm -rf "$tmp"
    return 1
  fi

  # A single .pkg installed to / needs administrator rights, and sudo will ask
  # for a password. Say so BEFORE the prompt appears: an unexplained password
  # box is exactly the sort of thing people are right to refuse.
  printf '\n'
  rule
  printf '  macOS will now ask for your Mac password. Installing Node.js puts\n'
  printf '  files in a shared folder (/usr/local), which needs your permission.\n'
  printf '  The installer is the official one, downloaded from nodejs.org just\n'
  printf '  now, and you can cancel here with no harm done.\n'
  rule
  printf '\n'

  if ! sudo installer -pkg "$tmp/node.pkg" -target /; then
    printf '\n[keys] The installer did not finish. Nothing has been changed.\n'
    printf '[keys] If it asked for a password and you cancelled, that is why.\n'
    rm -rf "$tmp"
    return 1
  fi

  rm -rf "$tmp"
  return 0
}

install_node() {
  if command -v brew >/dev/null 2>&1; then
    install_with_homebrew && return 0
    printf '\n[keys] Homebrew could not install Node. Trying the official installer.\n'
  fi
  install_with_pkg
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
cd "$ROOT" || { printf 'Cannot find the project folder.\n'; pause_and_exit 1; }

if [ ! -f "$LAUNCH_JS" ]; then
  printf 'Cannot find %s\n' "$LAUNCH_JS"
  printf 'This file has to stay in the desktop/ folder of the project.\n'
  pause_and_exit 1
fi

printf '\nSt. Peter'"'"'s Keys — starting up.\n'

if ! find_node; then
  # Distinguish "no Node at all" from "a Node that is too old", because the
  # second one has a version number in it and people find that reassuring.
  existing=""
  if command -v node >/dev/null 2>&1; then
    existing="$(node --version 2>/dev/null)"
  fi
  if [ -n "$existing" ]; then
    printf '\n[keys] Found Node %s, which is older than Node %s.\n' \
      "$existing" "$MIN_MAJOR"
  else
    printf '\n[keys] Node.js is not installed on this Mac.\n'
  fi

  if ask_consent; then
    if install_node; then
      hash -r 2>/dev/null || true
      if find_node; then
        printf '\n[keys] Node.js installed: %s (%s)\n' \
          "$NODE_BIN" "$("$NODE_BIN" --version)"
      else
        printf '\n[keys] Node.js was installed but cannot be found from here.\n'
        printf '[keys] Closing this window and double-clicking again usually\n'
        printf '[keys] fixes that, because the new PATH is picked up then.\n'
        open_from_disk
        pause_and_exit 0
      fi
    else
      printf '\n[keys] Node.js was not installed.\n'
      open_from_disk
      pause_and_exit 0
    fi
  else
    printf '\n[keys] Not installing anything. That is a perfectly good answer.\n'
    open_from_disk
    pause_and_exit 0
  fi
fi

printf '[keys] Using Node %s (%s)\n' "$("$NODE_BIN" --version)" "$NODE_BIN"

# Not exec'd, for one reason: if the launcher fails, this shell is still here
# to hold the window open on the message. That costs a shell in the middle, and
# a shell in the middle has to pass signals on — bash will not run a trap while
# it is waiting on a FOREGROUND child, so the launcher is started in the
# background and waited for, which is the only arrangement where Ctrl-C, a
# closed window and a plain `kill` all actually reach it. Without this, killing
# the window's shell would leave the server listening with nobody watching it.
#
# Everything is quoted. A project folder called "St Peter's Keys 2026" on a
# Desktop with a space in its path is the normal case, not the exotic one.
"$NODE_BIN" "$LAUNCH_JS" "$@" &
child=$!

trap 'kill -TERM "$child" 2>/dev/null || true' TERM
trap 'kill -INT  "$child" 2>/dev/null || true' INT
trap 'kill -HUP  "$child" 2>/dev/null || true' HUP

wait "$child"
status=$?
# A wait cut short by a signal returns >128 and the child is still winding
# down; wait again so this window does not close ahead of it.
if [ "$status" -gt 128 ]; then
  wait "$child" 2>/dev/null
  status=$?
fi

if [ "$status" -ne 0 ]; then
  printf '\n[keys] The newsletter did not start (exit code %s).\n' "$status"
  printf '[keys] The reason is in the lines above.\n'
  pause_and_exit "$status"
fi

exit 0
