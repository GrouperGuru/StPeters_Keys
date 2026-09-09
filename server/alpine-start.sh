#!/bin/sh
# =============================================================================
#  alpine-start.sh — install the nginx site config if missing, start the app,
#                    then start nginx. Alpine / OpenRC. Safe to re-run.
#
#    ./server/alpine-start.sh                 the whole job
#    ./server/alpine-start.sh --skip-nginx    start only the app server
#    ./server/alpine-start.sh --check-conf    show what the config would be
#    ./server/alpine-start.sh --force-conf    overwrite a config we did not write
#    ./server/alpine-start.sh --take-default-server
#                                             rename any other site holding
#                                             default_server on port 80
#    ./server/alpine-start.sh --help
#
#  Run as root: rc-service and /etc/nginx both need it.
#
#  Environment:
#    KEYS_PORT         port the app listens on          (default 8749)
#    KEYS_SERVER_NAME  nginx server_name                (default: catch-all)
#    KEYS_NGINX_CONF   where the site config is written
#                      (default /etc/nginx/http.d/stpeters-keys.conf)
#
#  WHY THE SERVER GOES UP FIRST, AND NGINX SECOND
#
#  nginx here is the reverse proxy in front of the app. Starting it BEFORE the
#  thing it forwards to means every request that arrives in the gap gets a 502,
#  which looks to whoever is holding the page like the app is broken. Backend
#  first, front door second, is the order that has no such window.
#
#  If the server fails to start, nginx is deliberately NOT started: a proxy
#  with nothing behind it serves 502s to the whole parish and hides the real
#  error, which is on this screen.
#
#  WHAT NGINX MUST NOT BE: a plain file server for this folder. If nginx serves
#  these files directly rather than proxying, the app loads and then says "This
#  is not the St. Peter's Keys server" — nginx hands over index.html and the
#  JavaScript quite happily and then answers 404 to every /api/... request.
#  Writing the config here is what stops that being a manual step people get
#  wrong on a fresh deployment.
#
#  WHY #!/bin/sh AND NOT #!/bin/bash
#
#  Alpine has no bash in the base image; /bin/sh is BusyBox ash. A bash
#  shebang fails there with "not found", which reads as though the SCRIPT is
#  missing rather than the shell. Everything below is POSIX and runs the same
#  under bash, so `apk add bash` is not needed for this.
# =============================================================================
set -eu

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SELF_DIR/.." && pwd)

SKIP_NGINX=0
FORCE_CONF=0
CHECK_CONF=0
TAKE_DEFAULT=0
for arg in "$@"; do
  case "$arg" in
    --skip-nginx|--no-nginx|--keep-nginx) SKIP_NGINX=1 ;;
    --force-conf|--force-nginx-conf)      FORCE_CONF=1 ;;
    --check-conf|--print-conf)            CHECK_CONF=1 ;;
    --take-default-server)                TAKE_DEFAULT=1 ;;
    -h|--help)
      sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      printf 'Try: %s --help\n' "$0" >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

APP_PORT=${KEYS_PORT:-8749}
NGINX_CONF=${KEYS_NGINX_CONF:-/etc/nginx/http.d/stpeters-keys.conf}
NGINX_MAIN_CONF=${KEYS_NGINX_MAIN_CONF:-/etc/nginx/nginx.conf}
SERVER_NAME=${KEYS_SERVER_NAME:-}
MARKER='# managed-by: St Peters Keys -- server/alpine-start.sh'

case "$APP_PORT" in
  ''|*[!0-9]*) die "KEYS_PORT must be a number, got \"$APP_PORT\"" ;;
esac

# KEYS_SERVER_NAME is substituted into a config file by a root-run script, so
# it is checked rather than trusted. Letters, digits, dot, dash, underscore,
# `*` for a wildcard, and spaces to list several names — nothing else. A stray
# `&` or `|` would be taken by sed as syntax and would quietly corrupt the
# config rather than fail.
case "$SERVER_NAME" in
  '') : ;;
  *[!A-Za-z0-9.*_\ -]*)
    die "KEYS_SERVER_NAME may contain only letters, digits, . - _ * and
       spaces (to list several names). Got: \"$SERVER_NAME\"" ;;
esac

# =============================================================================
#  THE NGINX SITE CONFIG
# =============================================================================

# The config, rendered to stdout. Written with placeholders and a QUOTED
# heredoc so the shell leaves nginx's own $host, $scheme and friends alone —
# an unquoted heredoc would expand them to empty strings and produce a config
# that is valid, silent, and completely wrong.
render_conf() {
  listen_line=$1
  name_line=$2
  cat <<'NGINXCONF' | sed \
    -e "s|@@LISTEN@@|$listen_line|" \
    -e "s|@@SERVER_NAME@@|$name_line|" \
    -e "s|@@PORT@@|$APP_PORT|" \
    -e "s|@@MARKER@@|$MARKER|"
@@MARKER@@
#
# Generated file. Re-running server/alpine-start.sh will rewrite it, so local
# edits belong somewhere else — or drop the marker line above and the script
# will leave this file alone from then on.
#
# This site PROXIES to the app. It must never serve the checkout as files:
# nginx would hand over index.html and the editor happily and then answer 404
# to every /api/... request, and the app would show "This is not the
# St. Peter's Keys server". That is why there is no root, index or try_files
# anywhere below.

# X-Forwarded-Proto, decided once.
#
# Forward what an upstream proxy already told us (Caddy, a Cloudflare tunnel,
# any other TLS terminator further out), and fall back to our own scheme only
# when there is nothing to forward. Hard-coding $scheme here is the classic
# mistake for a chain: nginx listens on plain HTTP inside the container, so
# $scheme is "http", the app concludes the browser is not on TLS, and the
# session cookie loses its Secure flag on a site that is HTTPS end to end.
map $http_x_forwarded_proto $keys_forwarded_proto {
    default $http_x_forwarded_proto;
    ''      $scheme;
}

server {
    @@LISTEN@@
    @@SERVER_NAME@@

    # The newsletter is mostly text, but an imported logo can be large.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:@@PORT@@;
        proxy_http_version 1.1;

        # Host MUST be the browser's host, not the backend's.
        #
        # nginx defaults this to the proxy_pass address. The app compares the
        # browser's Origin header against Host to stop cross-site request
        # forgery, so with the default every sign-in fails with 403 CSRF while
        # the rest of the site works perfectly — which is a miserable thing to
        # debug. Measured, not guessed.
        proxy_set_header Host              $host;

        # Append, never replace. The app reads the FIRST entry as the visitor's
        # address for rate limiting. $remote_addr would overwrite the real
        # visitor with the address of whatever proxy is in front, and then the
        # whole school would share one five-attempt sign-in budget.
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-Proto $keys_forwarded_proto;

        proxy_connect_timeout 5s;
        proxy_read_timeout    60s;
    }
}
NGINXCONF
}

# Files other than ours that claim `default_server` on this port. Two of them
# is not a warning, it is a hard nginx startup failure ("duplicate default
# server"), so this has to be settled before writing anything.
other_default_servers() {
  dir=$(dirname "$NGINX_CONF")
  [ -d "$dir" ] || return 0
  for f in "$dir"/*.conf; do
    [ -e "$f" ] || continue
    [ "$f" = "$NGINX_CONF" ] && continue
    if grep -qE '^[[:space:]]*listen[^;]*default_server' "$f" 2>/dev/null; then
      printf '%s\n' "$f"
    fi
  done
}

# Does this file use an nginx directive anywhere?
#
# Deliberately NOT anchored to the start of a line. `location / { proxy_pass
# http://...; }` on one line is entirely ordinary nginx, and an anchored match
# would miss it — which here would mean reading somebody's live proxied site as
# an empty placeholder and renaming it. A commented-out directive counts as a
# match, which errs towards leaving the file alone: the safe direction.
mentions() {
  grep -qE "(^|[^A-Za-z0-9_])$2[[:space:]]" "$1" 2>/dev/null
}

# Is this file safe to displace — a placeholder, or a previous attempt at
# serving THIS app — rather than somebody's real site?
#
# The question is asked about what the file DOES, not what it is called. An
# earlier version of this matched one hardcoded path (/var/www/localhost/htdocs)
# and so failed to recognise stock Alpine, whose current default.conf answers
# `return 404` for everything and mentions no directory at all. Refusing to
# touch the packaged placeholder is not caution, it is a broken deployment for
# no benefit.
#
# Erring towards refusal is still right: renaming a live site is far worse than
# stopping and asking. Anything not recognised here needs --take-default-server
# or KEYS_SERVER_NAME.
looks_like_placeholder() {
  f=$1

  # Anything that proxies somewhere is doing real work. Not ours to move.
  mentions "$f" proxy_pass && return 1

  # Older stock (Alpine, Debian): the packaged "welcome" page.
  grep -q '/var/www/localhost/htdocs' "$f" 2>/dev/null && return 0

  # Current Alpine stock: every location just returns 404, and no directory is
  # served at all.
  if grep -qE '(^|[^A-Za-z0-9_])return[[:space:]][[:space:]]*404' "$f" 2>/dev/null \
     && ! mentions "$f" root && ! mentions "$f" alias; then
    return 0
  fi

  # A previous attempt to serve THIS checkout as plain files — precisely the
  # misconfiguration that produces "This is not the St. Peter's Keys server",
  # and exactly what this script exists to replace. Matched with grep -F
  # because a checkout path may contain regex metacharacters.
  if { mentions "$f" root || mentions "$f" alias; } \
     && grep -qF "$ROOT" "$f" 2>/dev/null; then
    return 0
  fi

  return 1
}

# Where nginx keeps its pid file, according to nginx itself.
#
# Read rather than assumed: /run/nginx is Alpine's default, but the path comes
# from a `pid ...;` line in nginx.conf and a rebuilt package or a hand-edited
# config can put it somewhere else. Hard-coding it would mean this whole
# mechanism silently stops working on exactly the box that needs it, with no
# sign that it did.
nginx_pid_dir() {
  p=''
  if [ -r "$NGINX_MAIN_CONF" ]; then
    # BRE only: BusyBox sed has no \+, so the space is spelled out longhand.
    # The leading ^[[:space:]]*pid anchor matters — without it this would also
    # match `proxy_pid`, `pid_file` or a `pid` inside a comment.
    p=$(sed -n 's/^[[:space:]]*pid[[:space:]][[:space:]]*\([^;]*\);.*/\1/p' \
          "$NGINX_MAIN_CONF" 2>/dev/null \
        | sed 's/[[:space:]]*$//' | tail -1)
  fi
  [ -n "$p" ] || p=/run/nginx/nginx.pid
  dirname "$p"
}

# Make sure the pid directory exists before anything runs nginx.
#
# /run is a tmpfs: it is empty after every boot, and it is the OpenRC init
# script's start_pre — not nginx — that recreates this directory. Alpine's
# packaged init script does do that, so ahead of `rc-service nginx start` this
# is usually redundant. It is here anyway for two reasons.
#
# First, anything that runs the nginx binary DIRECTLY bypasses start_pre
# entirely: `nginx -t` below, or a hand-run `nginx -s reload`. That is the
# failure that started all this, and it is thoroughly misleading —
#
#     nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
#     nginx: [emerg] open() "/run/nginx/nginx.pid" failed (2: No such file...)
#
# — a pid-file problem reported as a configuration test failure, on a
# configuration that is fine.
#
# Second, it costs one stat on the overwhelmingly common path where the
# directory is already there. Being independent of what somebody else's init
# script does is worth more than that.
ensure_run_dir() {
  d=$(nginx_pid_dir)
  [ -d "$d" ] && return 0
  mkdir -p "$d" 2>/dev/null || return 1
  # The nginx user may not exist yet (nginx not installed, or a custom build
  # running as somebody else). The master process writes the pid as root
  # regardless, so a failed chown is not worth stopping for.
  chown nginx:nginx "$d" 2>/dev/null || true
  say "  Created $d — /run is a tmpfs and is emptied at every boot."
  return 0
}

# `nginx -t`, made trustworthy.
#
# The result is only ever used as a BEFORE/AFTER comparison below, never as a
# gate on its own: an earlier version of this script gated on it and refused to
# start an nginx that would have started perfectly well.
nginx_test() {
  command -v nginx >/dev/null 2>&1 || return 0
  ensure_run_dir || true
  nginx -t >/dev/null 2>&1
}

# Will nginx actually READ the file we are about to write, and is there a
# competing site hiding in the main config?
#
# Both of these are silent failures, which is why they are worth a check of
# their own. Writing a perfect config into a directory nginx does not include
# produces a script that reports success and changes nothing observable —
# the worst possible outcome, because it sends you looking somewhere else.
#
# The second case matters especially when the checkout lives in nginx's default
# document root (/var/www/html and friends): a `server {}` block sitting
# directly in nginx.conf will serve the app as plain files, and nothing in
# http.d/ can override it.
warn_about_main_conf() {
  [ -r "$NGINX_MAIN_CONF" ] || return 0
  incdir=$(dirname "$NGINX_CONF")

  # Is our directory included? Matched loosely on the directory name, because
  # the glob may be written *.conf, */*.conf or with quotes.
  if ! grep -qE '^[[:space:]]*include[^;]*'"$(basename "$incdir")"'/' "$NGINX_MAIN_CONF" 2>/dev/null; then
    say ""
    say "  WARNING: $NGINX_MAIN_CONF does not appear to include $incdir/"
    say "  Nothing written there will have any effect. Add this inside its"
    say "  http { } block, then run this script again:"
    say "        include $incdir/*.conf;"
    say ""
  fi

  # A server block in the main config cannot be displaced from http.d/.
  if grep -qE '^[[:space:]]*server[[:space:]]*\{' "$NGINX_MAIN_CONF" 2>/dev/null; then
    say ""
    say "  WARNING: $NGINX_MAIN_CONF contains a server { } block of its own."
    if grep -qF "$ROOT" "$NGINX_MAIN_CONF" 2>/dev/null; then
      say "  It mentions $ROOT — so it is very likely THE thing serving this"
      say "  folder as plain files, and it is the reason the app says it is"
      say "  not its own server."
    fi
    say "  A site defined there cannot be overridden from $incdir/."
    say "  Move it out, or comment it out, and run this script again."
    say ""
  fi
}

CONF_CHANGED=0

ensure_nginx_conf() {
  dir=$(dirname "$NGINX_CONF")

  # --check-conf only prints; it must not need root, and must not create
  # anything. Being able to review the config on a laptop before it is applied
  # to a live box is most of the point of the flag.
  if [ "$CHECK_CONF" -eq 0 ] && [ ! -d "$dir" ]; then
    mkdir -p "$dir" 2>/dev/null \
      || die "cannot create $dir — run as root, or set KEYS_NGINX_CONF"
  fi

  # --- decide whether we can be the default server -------------------------
  conflicts=$(other_default_servers)
  listen_line='listen 80 default_server;'

  if [ -n "$conflicts" ]; then
    for f in $conflicts; do
      if looks_like_placeholder "$f" || [ "$TAKE_DEFAULT" -eq 1 ]; then
        say "  Disabling $f"
        say "    (it claims default_server on port 80, and two of those stop"
        say "     nginx from starting at all. Renamed, not deleted.)"
        mv "$f" "$f.disabled-by-keys" \
          || die "could not rename $f"
      elif [ -n "$SERVER_NAME" ]; then
        # Their site keeps default_server; we match on the hostname instead,
        # and an exact server_name beats a default_server anyway.
        say "  Note: $f already claims default_server — leaving it alone."
        say "        This site will match on \"$SERVER_NAME\" instead."
        listen_line='listen 80;'
      else
        # Show it. Being told a file is in the way without being told what is
        # in it leaves the reader to go and look before they can decide, and
        # in a deploy log they cannot go and look at all.
        say ""
        say "  $f claims default_server on port 80, and it does not look like"
        say "  a placeholder, so it is not this script's to disable. It says:"
        say ""
        sed -n '1,25p' "$f" 2>/dev/null | sed 's/^/      /'
        say ""
        die "nothing has been changed. Two ways forward:

       If that is a real site, give this app its own hostname —
       it will then match on the name and leave that site alone:

           KEYS_SERVER_NAME=keys.example.org $0

       If it is stale, or is the thing serving this folder as plain
       files, have it renamed to .disabled-by-keys:

           $0 --take-default-server"
      fi
    done
  fi

  if [ -n "$SERVER_NAME" ]; then
    name_line="server_name $SERVER_NAME;"
  else
    # `_` is not a wildcard — it is simply a name no Host can equal. It works
    # only because the block is also default_server, which is what actually
    # catches the request.
    name_line='server_name _;'
  fi

  if [ "$CHECK_CONF" -eq 1 ]; then
    render_conf "$listen_line" "$name_line"
    return 0
  fi

  # --- write it, if it is not already exactly right ------------------------
  tmp="$NGINX_CONF.keys-new.$$"
  render_conf "$listen_line" "$name_line" > "$tmp" \
    || { rm -f "$tmp"; die "could not write $tmp"; }

  if [ -f "$NGINX_CONF" ]; then
    if cmp -s "$tmp" "$NGINX_CONF"; then
      rm -f "$tmp"
      say "  nginx config is already correct: $NGINX_CONF"
      return 0
    fi
    if ! grep -qF "$MARKER" "$NGINX_CONF" 2>/dev/null && [ "$FORCE_CONF" -eq 0 ]; then
      rm -f "$tmp"
      die "$NGINX_CONF exists and was not written by this script, so it has
       not been touched. Look at it, and then either delete it or re-run
       with --force-conf to replace it. To see what would be written:

           $0 --check-conf"
    fi
    backup="$NGINX_CONF.bak-$(date +%Y%m%d%H%M%S)"
    cp "$NGINX_CONF" "$backup" || die "could not back up $NGINX_CONF"
    say "  Replacing $NGINX_CONF (previous kept as $(basename "$backup"))"
  else
    backup=''
    say "  Writing $NGINX_CONF"
  fi

  # Whether nginx was happy BEFORE we touched anything. Without this baseline
  # a pre-existing, unrelated config error elsewhere would be blamed on us and
  # trigger a pointless rollback.
  was_ok=0
  nginx_test && was_ok=1

  mv "$tmp" "$NGINX_CONF" || { rm -f "$tmp"; die "could not install $NGINX_CONF"; }
  chmod 644 "$NGINX_CONF" 2>/dev/null || true
  CONF_CHANGED=1

  if [ "$was_ok" -eq 1 ] && ! nginx_test; then
    # We broke it. Put back exactly what was there and say so — leaving a
    # deployment with a config that cannot start is worse than changing
    # nothing at all.
    say ""
    say "  The config we just wrote does not pass nginx -t:"
    nginx -t 2>&1 | sed 's/^/      /' || true
    if [ -n "$backup" ]; then
      mv "$backup" "$NGINX_CONF"
      say "  Rolled back to the previous config."
    else
      rm -f "$NGINX_CONF"
      say "  Removed it again (there was nothing there before)."
    fi
    CONF_CHANGED=0
    die "nginx configuration was left as it was found. This is a bug in
       alpine-start.sh — please report the nginx -t output above."
  fi
}

if [ "$CHECK_CONF" -eq 1 ]; then
  ensure_nginx_conf
  exit 0
fi

# =============================================================================
#  CHECKS
# =============================================================================
[ -f "$ROOT/server/server.js" ] || die "no server/server.js next to this script (looked in $ROOT)"

command -v node >/dev/null 2>&1 || die "node is not installed. On Alpine:  apk add nodejs"

# The server needs Node 20 or newer. Compared as a NUMBER, not with a string
# test: "9" sorts above "20" as text, so a string comparison would happily
# accept Node 9 and then fail somewhere much less obvious.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "could not read the Node version" ;;
esac
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR is too old; this needs Node 20 or newer"

# =============================================================================
#  THE SERVER, FIRST
# =============================================================================
say "Starting St. Peter's Keys…"

# start.js is the wrapper around server.js: it starts exactly that, and adds
# the two things worth having here — it prints the first-run setup token as
# the LAST thing on screen rather than letting it scroll away, and it refuses
# to start a second copy on a port that already answers.
#
# --background so this script can carry on and bring nginx up behind it.
# start.js only reports success once the server actually answers, so reaching
# the next line means there is something for nginx to forward to.
cd "$ROOT"
KEYS_RC=0
node server/start.js --background || KEYS_RC=$?

if [ "$KEYS_RC" -ne 0 ]; then
  # start.js exits non-zero both when the server FAILED to start and when it
  # was ALREADY running, and those need opposite responses. Ask what is
  # actually true rather than inferring it from the exit code: if a server of
  # ours is up, carry on to nginx, so running this script twice finishes the
  # job instead of refusing. A start script that cannot be run twice is no use
  # when the first run got half way — which is exactly when a deployment
  # script re-runs it.
  if node -e 'var f=require("./server/instances.js").findOurServers();
              process.exit(f && f.length ? 0 : 1);' 2>/dev/null; then
    say ""
    say "The server was already up — carrying on to nginx."
  else
    say ""
    die "the server is not running, so nginx has been left alone.
       Starting a proxy with nothing behind it would serve 502s to everyone
       and hide the real error, which is above."
  fi
fi

# =============================================================================
#  NGINX, SECOND
# =============================================================================
say ""
if [ "$SKIP_NGINX" -eq 1 ]; then
  say "Not touching nginx (--skip-nginx)."
elif ! command -v rc-service >/dev/null 2>&1; then
  say "No rc-service here, so nginx was not started (this is not Alpine/OpenRC)."
elif [ ! -e /etc/init.d/nginx ]; then
  say "nginx is not installed here — nothing to start."
  say "  To install it:  apk add nginx"
  say "  Then run this script again and it will write the site config."
else
  # Unconditionally, before anything reads or runs nginx.
  #
  # This must NOT live inside ensure_nginx_conf: on the ordinary re-run the
  # config is already correct, so that function returns early and nginx_test is
  # never reached. A deploy script re-running after a reboot would then start
  # nginx with the directory still missing — the one case where this matters
  # most.
  ensure_run_dir || say "  Note: could not create $(nginx_pid_dir) — not root?"

  say "Checking the nginx site config…"
  ensure_nginx_conf
  warn_about_main_conf

  if rc-service nginx status >/dev/null 2>&1; then
    if [ "$CONF_CHANGED" -eq 1 ]; then
      # A reload rather than a restart: it picks up the new config without
      # dropping connections that are already in progress.
      say "  nginx is running and the config changed — reloading."
      if ! rc-service nginx reload; then
        say "  Reload failed; trying a restart."
        rc-service nginx restart || die "nginx would not reload or restart"
      fi
      say "nginx reloaded."
    else
      say "nginx is already running, and its config is unchanged."
    fi
  else
    # DO NOT gate this on `nginx -t`. See the comment on nginx_test() above:
    # standalone it reports a bogus pid-file failure on a fresh boot, and an
    # earlier version of this script refused to start a perfectly good nginx
    # because of it. Act first, diagnose only on a real failure.
    say "Starting nginx…"
    if rc-service nginx start; then
      say "nginx started."
      # A service started by hand does not come back after a reboot. On a box
      # meant to serve the parish unattended, that is worth one line now
      # rather than a puzzled morning later.
      if ! rc-update show default 2>/dev/null | grep -q '^ *nginx'; then
        say "  Note: nginx is not enabled at boot. To make it come back:"
        say "        rc-update add nginx default"
      fi
    else
      say ""
      say "nginx did not start. Its own config test says:"
      if command -v nginx >/dev/null 2>&1; then
        ensure_run_dir || true
        nginx -t 2>&1 | sed 's/^/    /' || true
        say ""
        say "  If one line says the syntax is ok and a later one still"
        say "  complains about a pid file, the config is NOT the problem."
        say "  This script already created $(nginx_pid_dir), so something"
        say "  else is wrong with it — check that /run is mounted and"
        say "  writable, and that the pid path in /etc/nginx/nginx.conf is"
        say "  the one you expect."
      else
        say "    (the nginx binary is not on PATH, so there is nothing to ask)"
      fi
      say ""
      say "The app server IS running; only the proxy is down."
      exit 1
    fi
  fi
fi

say ""
say "Stop everything again with:  ./server/alpine-stop.sh"
