#!/bin/sh
# =============================================================================
#  alpine-stop.sh — stop nginx, then stop St. Peter's Keys. Alpine / OpenRC.
#
#    ./server/alpine-stop.sh             stop nginx, then the server
#    ./server/alpine-stop.sh --skip-nginx    stop only the server
#    ./server/alpine-stop.sh --dry-run   show what would be stopped
#    ./server/alpine-stop.sh --help
#
#  Run as root: rc-service needs it.
#
#  WHY NGINX GOES DOWN FIRST — the exact reverse of alpine-start.sh
#
#  nginx is the reverse proxy in front of the app. Stopping the app first would
#  leave the proxy up with nothing behind it, so every request arriving in that
#  window gets a 502 instead of the honest "nothing is listening here" a
#  stopped site should give. Closing the front door first means no request ever
#  reaches a backend that is on its way out.
#
#  The order matters for the shutdown itself too. With nginx already gone, no
#  new requests arrive, so server/stop.js's SIGTERM finds the server idle: it
#  stops listening, lets anything already in flight finish, and flushes a
#  queued accounts.json write before exiting. That wait is why an account added
#  seconds earlier is not lost.
#
#  WHY #!/bin/sh AND NOT #!/bin/bash — Alpine has no bash in the base image;
#  /bin/sh is BusyBox ash. Everything here is POSIX and runs the same in bash.
# =============================================================================
set -eu

SELF_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SELF_DIR/.." && pwd)

SKIP_NGINX=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --skip-nginx|--no-nginx|--keep-nginx) SKIP_NGINX=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
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

[ -f "$ROOT/server/stop.js" ] || die "no server/stop.js next to this script (looked in $ROOT)"
command -v node >/dev/null 2>&1 || die "node is not installed. On Alpine:  apk add nodejs"

# --- nginx, first ------------------------------------------------------------
if [ "$SKIP_NGINX" -eq 1 ]; then
  say "Not touching nginx (--skip-nginx)."
elif [ "$DRY_RUN" -eq 1 ]; then
  if [ -e /etc/init.d/nginx ] && rc-service nginx status >/dev/null 2>&1; then
    say "nginx is running and would be stopped first."
  else
    say "nginx is not running; nothing would be done to it."
  fi
elif ! command -v rc-service >/dev/null 2>&1; then
  say "No rc-service here, so nginx was not touched (this is not Alpine/OpenRC)."
elif [ ! -e /etc/init.d/nginx ]; then
  say "nginx is not installed here — nothing to stop."
elif rc-service nginx status >/dev/null 2>&1; then
  say "Stopping nginx…"
  # Not fatal if it refuses. The app server should still be brought down —
  # leaving it running because the proxy would not stop is the worse of the
  # two outcomes, and the failure is reported at the end either way.
  if rc-service nginx stop; then
    say "nginx stopped."
    NGINX_RC=0
  else
    say "nginx did not stop — carrying on to the app server anyway."
    NGINX_RC=1
  fi
else
  say "nginx is not running — nothing to stop."
fi

# --- the server, second ------------------------------------------------------
say ""
cd "$ROOT"

if [ "$DRY_RUN" -eq 1 ]; then
  say "Server processes that would be stopped:"
  node server/stop.js --dry-run
  # No closing "--dry-run: nothing was stopped" here: server/stop.js has just
  # said exactly that, and the nginx line above covers the rest. Saying it
  # twice reads like two different things were checked.
  exit 0
fi

say "Stopping St. Peter's Keys…"
# stop.js exits non-zero when it could not stop something it found, and zero
# when there was nothing running — the desired end state, not a failure.
# `set -e` would abort on the first case before the summary below, so the
# status is captured and reported instead.
KEYS_RC=0
node server/stop.js || KEYS_RC=$?

# --- summary -----------------------------------------------------------------
say ""
if [ "${NGINX_RC:-0}" -ne 0 ] || [ "$KEYS_RC" -ne 0 ]; then
  [ "${NGINX_RC:-0}" -ne 0 ] && say "nginx did not stop cleanly (are you root?)."
  [ "$KEYS_RC" -ne 0 ] && say "The server did not stop cleanly — see above."
  say "What is still answering:  node server/whats-serving.js"
  exit 1
fi

say "Stopped. Start it again with:  ./server/alpine-start.sh"
