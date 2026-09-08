#!/bin/sh
# =============================================================================
#  alpine-start.sh — start St. Peter's Keys, then start nginx. Alpine / OpenRC.
#
#    ./server/alpine-start.sh            start the server, then nginx
#    ./server/alpine-start.sh --skip-nginx   start only the server
#    ./server/alpine-start.sh --help
#
#  Run as root: rc-service needs it.
#
#  WHY THE SERVER GOES UP FIRST, AND NGINX SECOND
#
#  nginx here is the reverse proxy in front of the app — it terminates TLS and
#  forwards to the server on 127.0.0.1. Starting it BEFORE the thing it
#  forwards to means every request that arrives in the gap gets a 502, which
#  looks to whoever is holding the page like the app is broken. Backend first,
#  front door second, is the order that has no such window.
#
#  If the server fails to start, nginx is deliberately NOT started: a proxy
#  with nothing behind it serves 502s to the whole parish and hides the real
#  error, which is on this screen.
#
#  NOT what nginx must not be: a plain file server for this folder. If nginx is
#  configured to serve these files directly rather than proxy to the server,
#  the app loads and then says "This is not the St. Peter's Keys server",
#  because nginx hands over index.html and the JavaScript quite happily and
#  then answers 404 to every /api/... request. server/README.md has the
#  proxy_pass configuration; `node server/whats-serving.js` will tell you which
#  of the two you currently have.
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
for arg in "$@"; do
  case "$arg" in
    --skip-nginx|--no-nginx|--keep-nginx) SKIP_NGINX=1 ;;
    -h|--help)
      sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
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

# --- checks ------------------------------------------------------------------
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

# --- the server, first -------------------------------------------------------
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
  # when the first run got half way.
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

# --- nginx, second -----------------------------------------------------------
say ""
if [ "$SKIP_NGINX" -eq 1 ]; then
  say "Not touching nginx (--skip-nginx)."
elif ! command -v rc-service >/dev/null 2>&1; then
  say "No rc-service here, so nginx was not started (this is not Alpine/OpenRC)."
elif [ ! -e /etc/init.d/nginx ]; then
  say "nginx is not installed here — nothing to start."
elif rc-service nginx status >/dev/null 2>&1; then
  # Already up. Left running rather than restarted: a restart would drop
  # connections for no reason, and the config on disk may not be the config it
  # is running deliberately.
  say "nginx is already running — left as it is."
  say "  To pick up a changed config:  rc-service nginx reload"
else
  # `nginx -t` first. Starting with a bad config fails with a terse init-script
  # message, while nginx -t names the file and line. Cheap, and it turns the
  # commonest nginx problem into a readable one.
  if command -v nginx >/dev/null 2>&1 && ! nginx -t >/dev/null 2>&1; then
    say "nginx configuration is not valid — not starting it. The details:"
    nginx -t 2>&1 | sed 's/^/    /' || true
    say ""
    say "The app server IS running; only the proxy is down."
    exit 1
  fi

  say "Starting nginx…"
  if rc-service nginx start; then
    say "nginx started."
    # A service started by hand does not come back after a reboot. On a box
    # that is meant to serve the parish unattended, that is worth one line
    # now rather than a puzzled morning later.
    if ! rc-update show default 2>/dev/null | grep -q '^ *nginx'; then
      say "  Note: nginx is not enabled at boot. To make it come back:"
      say "        rc-update add nginx default"
    fi
  else
    say ""
    say "nginx did not start. The app server IS running; only the proxy is down."
    exit 1
  fi
fi

say ""
say "Stop everything again with:  ./server/alpine-stop.sh"
