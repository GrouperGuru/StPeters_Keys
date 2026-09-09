/* =============================================================================
 * server/instances.js — finding the server's own processes, and only those.
 *
 * Shared by start.js and stop.js. Not a public API and not required by
 * server.js: the server itself knows nothing about this file.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE, AND WHY IT IS THIS CAUTIOUS
 *
 * stop.js has to be able to stop a server somebody started by hand, which
 * means looking through the machine's process list and matching. Matching
 * loosely there is how a tool kills the wrong thing — `pkill node` on a box
 * that also runs something else in Node is a genuinely bad afternoon, and
 * during this project's own development a stray `kill -9` on a process that
 * merely *looked* like it belonged took out an unrelated one.
 *
 * So the rule enforced here, in one place so it cannot drift between the two
 * scripts, is: a process is ours only if it is a Node binary whose arguments
 * name THIS checkout's server/server.js, compared as an absolute,
 * symlink-resolved path. A relative argument is resolved against that
 * process's own working directory, never matched on its tail — `server.js`
 * relative to somebody else's project is a different program.
 *
 * PORTABILITY, which is load-bearing rather than incidental:
 *   - Linux (including Alpine and any BusyBox userland) reads /proc directly.
 *     No `ps`, because the flags this needs are a GNU extension BusyBox does
 *     not implement, and /proc additionally hands over argv pre-split on NUL.
 *   - macOS and the BSDs shell out to `ps`.
 *   - Windows asks PowerShell for Win32_Process.
 *
 * Consequences of that rule, all of them intended:
 *   - a server from a different copy of the project is not ours, and is left
 *     alone. Two checkouts on one machine stay independent.
 *   - a bare `node` process is never a match, whatever it is doing.
 *   - an editor, a test harness or a shell whose command line merely MENTIONS
 *     the path — `vim server/server.js`, `grep server.js` — would match on
 *     text alone, so the executable is checked too: the command line has to
 *     start with something that looks like a Node binary.
 *
 * The PID file is a fast path, not the authority. It can be stale — a machine
 * can reboot, a process can be killed from elsewhere, and a PID can be reused
 * by something completely unrelated. Every PID read from it is therefore put
 * through the same identity check as one found by scanning.
 * ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HERE = __dirname;

/* realpathSync so that /var -> /private/var on macOS, and any symlinked
 * checkout, compare equal to what `ps` reports. Without this the matcher
 * silently finds nothing on exactly the systems where symlinks are normal. */
function realOrSelf(p) {
  try { return fs.realpathSync(p); } catch (e) { return p; }
}

const SERVER_PATH = realOrSelf(path.join(HERE, 'server.js'));
const ROOT = realOrSelf(path.resolve(HERE, '..'));

/* The PID file lives in the temp directory, NOT in KEYS_DATA.
 *
 * That is deliberate: local mode (the desktop app) must never create
 * server/data — there is a test asserting the directory does not appear — and
 * a start script that dropped a pid file in there would break that invariant
 * for the sake of its own bookkeeping. Keyed by a hash of the checkout path so
 * two copies of the project do not fight over one file. */
const PID_FILE = path.join(
  os.tmpdir(),
  'stpeters-keys-' + crypto.createHash('sha256').update(ROOT).digest('hex').slice(0, 12) + '.pid'
);

function pidFilePath() { return PID_FILE; }

function writePidFile(pid, port) {
  try {
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify({ pid: pid, port: port || null, root: ROOT, at: Date.now() }),
      { mode: 0o600 }
    );
    return true;
  } catch (e) {
    /* Not fatal. stop.js can still find the process by scanning; the pid file
     * only ever makes that faster. */
    return false;
  }
}

function readPidFile() {
  try {
    const d = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (!d || typeof d.pid !== 'number' || d.pid <= 1) return null;
    /* A pid file describing a different checkout is not ours to act on. */
    if (d.root && d.root !== ROOT) return null;
    return d;
  } catch (e) {
    return null;
  }
}

function clearPidFile(onlyIfPid) {
  try {
    if (onlyIfPid) {
      const d = readPidFile();
      if (d && d.pid !== onlyIfPid) return false;
    }
    fs.unlinkSync(PID_FILE);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * The process list
 * ------------------------------------------------------------------------ */
/* On Linux, read /proc rather than shelling out to `ps`.
 *
 * This is not an optimisation, it is a correctness fix. `ps ax -o pid=,command=`
 * is procps syntax — the `=` suffix that suppresses the column header is a GNU
 * extension. Alpine, and any other BusyBox userland, ships a `ps` that does not
 * understand it, so on the containers this project is most likely to be
 * deployed in that call fails and stop.js loses the ability to find anything.
 * It would then say "the server is not running" at a running server, which is
 * the worst kind of wrong answer: confident and actionable.
 *
 * /proc needs no external command at all, and it hands over argv already split
 * on NUL — so the arguments arrive exactly as the process received them, with
 * no quoting to guess at. That is strictly better evidence than a reconstructed
 * command string, and it is what the matcher prefers when it is available. */
function listProcFs() {
  let names;
  try {
    names = fs.readdirSync('/proc');
  } catch (e) {
    return null;
  }

  const out = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let raw;
    try {
      raw = fs.readFileSync('/proc/' + name + '/cmdline');
    } catch (e) {
      /* Gone between readdir and read, or another user's process in a
       * hidepid mount. Both are ordinary; skip it. */
      continue;
    }
    if (!raw || raw.length === 0) continue;      // a kernel thread
    const argv = raw.toString('utf8').split('\0').filter((s) => s.length > 0);
    if (argv.length === 0) continue;
    out.push({ pid: pid, argv: argv, cmd: argv.join(' ') });
  }
  return out;
}

function listProcesses() {
  if (process.platform === 'linux') {
    const viaProc = listProcFs();
    /* No fallback to `ps` here on purpose: if /proc is not readable then this
     * is a sandbox that has hidden the process table, and `ps` — which reads
     * /proc itself — could not do better. */
    if (viaProc) return viaProc;
    return null;
  }

  try {
    if (process.platform === 'win32') {
      /* CommandLine is not available from tasklist, and wmic is on its way out
       * of Windows, so CIM it is. -NoProfile because a user profile that
       * prints anything would corrupt the output. */
      const out = execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'Get-CimInstance Win32_Process | ' +
        'Where-Object { $_.CommandLine } | ' +
        'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'
      ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      return out.split(/\r?\n/).map((line) => {
        const i = line.indexOf('\t');
        if (i === -1) return null;
        const pid = Number(line.slice(0, i).trim());
        if (!pid) return null;
        return { pid: pid, cmd: line.slice(i + 1).trim() };
      }).filter(Boolean);
    }

    /* macOS and the BSDs only — Linux is handled by /proc above, and must be,
     * because this is procps/BSD syntax that BusyBox does not accept. The `=`
     * suffixes suppress the column headers, so there is no first line to skip. */
    const out = execFileSync('ps', ['ax', '-o', 'pid=,command='],
      { encoding: 'utf8', timeout: 20000 });
    return out.split('\n').map((line) => {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) return null;
      return { pid: Number(m[1]), cmd: m[2].trim() };
    }).filter(Boolean);
  } catch (e) {
    return null;             // no ps, no powershell, or it timed out
  }
}

/* The working directory of another process, or null if it cannot be had.
 *
 * Needed because `ps` reports a command line exactly as it was typed, and the
 * documented way to start this server is `node server/server.js` from the
 * project root — a RELATIVE path. Matching only absolute paths therefore missed
 * the commonest case entirely, which is a bug this had before anybody used it:
 * stop.js reported "the server is not running" at a running server.
 *
 * The relative path is resolved against the process's own cwd rather than
 * matched loosely on its tail, because `server/server.js` relative to some
 * OTHER project directory is a different program and must not be signalled. */
function processCwd(pid) {
  try {
    if (process.platform === 'linux') {
      return realOrSelf(fs.readlinkSync('/proc/' + pid + '/cwd'));
    }
    if (process.platform === 'darwin') {
      /* -Fn gives machine-readable output: one field per line, prefixed by its
       * type. The cwd arrives as a line beginning with "n". */
      const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      const line = out.split('\n').find((l) => l.startsWith('n') && l.length > 1);
      return line ? realOrSelf(line.slice(1).trim()) : null;
    }
  } catch (e) {
    /* No /proc, no lsof, or not permitted for another user's process. */
  }
  return null;
}

/* Does this command line belong to a running copy of OUR server?
 *
 * Three conditions:
 *   1. the thing being run is a Node binary,
 *   2. one of its arguments names a file, and
 *   3. that file IS this checkout's server/server.js — compared as a resolved
 *      absolute path, resolving a relative argument against the process's own
 *      working directory.
 *
 * (1) is what keeps `vim /path/to/server/server.js` and
 * `grep -n x /path/to/server/server.js` out of the results. Without it this
 * function would happily nominate somebody's editor for termination.
 *
 * (3) is what keeps a different copy of the project out of the results, which
 * is the whole reason this is a path comparison and not a substring search for
 * the word "server.js".
 *
 * `pid` is optional: without it only absolute arguments can be judged, which
 * is the right way round — an unresolvable relative path returns false rather
 * than being guessed at. */
function commandIsOurServer(cmd, pid, argv) {
  const win = process.platform === 'win32';
  const norm = (p) => {
    const r = path.resolve(p);
    return win ? r.toLowerCase().replace(/\\/g, '/') : r;
  };
  const target = norm(SERVER_PATH);

  /* Prefer real argv when the caller has it — on Linux /proc gives arguments
   * already split on NUL, so a path containing spaces or quotes needs no
   * guessing. Splitting a joined string is the fallback for platforms where
   * only a command line is available, and it is the weaker of the two: a
   * filename with a space in it can be misread there and nowhere else. */
  let tokens;
  if (Array.isArray(argv) && argv.length) {
    tokens = argv;
  } else {
    if (!cmd) return false;
    tokens = cmd.match(/"[^"]*"|\S+/g) || [];
  }
  if (tokens.length < 2) return false;

  const exeToken = String(tokens[0]).replace(/^"|"$/g, '');
  const exe = path.basename(exeToken).toLowerCase();
  if (exe !== 'node' && exe !== 'node.exe' &&
      exe !== 'nodejs' && exe !== 'node.bin') {
    return false;
  }

  /* cwd is looked up lazily, and only when a relative candidate turns up — it
   * costs a subprocess on macOS and most matches never need it. */
  let cwd;
  let cwdChecked = false;
  const getCwd = () => {
    if (!cwdChecked) { cwdChecked = true; cwd = pid ? processCwd(pid) : null; }
    return cwd;
  };

  for (let i = 1; i < tokens.length; i++) {
    const raw = String(tokens[i]).replace(/^"|"$/g, '');
    if (!raw || raw.charAt(0) === '-') continue;      // a flag, not a path
    if (!/server\.js$/i.test(raw)) continue;          // only the file we care about

    if (path.isAbsolute(raw)) {
      if (norm(realOrSelf(raw)) === target) return true;
      continue;
    }
    const base = getCwd();
    if (!base) continue;
    if (norm(realOrSelf(path.resolve(base, raw))) === target) return true;
  }
  return false;
}

/* Alive AND ours. `kill(pid, 0)` only answers the first half — a recycled PID
 * is alive and belongs to somebody else entirely. */
function isOurServer(pid) {
  if (!pid || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e && e.code === 'EPERM') {
      /* Running, but owned by another user. Still has to prove it is ours. */
    } else {
      return false;
    }
  }
  const procs = listProcesses();
  if (procs === null) {
    /* Cannot see the process table. Refuse to guess: claiming a PID is ours on
     * no evidence is how the wrong process gets signalled. */
    return false;
  }
  const found = procs.find((p) => p.pid === pid);
  return !!(found && commandIsOurServer(found.cmd, found.pid, found.argv));
}

/* Every running copy of this checkout's server, PID file or not. */
function findOurServers() {
  const procs = listProcesses();
  if (procs === null) return null;

  const self = process.pid;
  const parent = typeof process.ppid === 'number' ? process.ppid : -1;

  return procs
    .filter((p) => p.pid > 1 && p.pid !== self && p.pid !== parent)
    .filter((p) => commandIsOurServer(p.cmd, p.pid, p.argv))
    .map((p) => ({
      pid: p.pid,
      cmd: p.cmd,
      /* Best-effort, for the report only — never used to decide anything. */
      local: /KEYS_LOCAL[=\s]*(1|true|yes|on)/i.test(p.cmd) || null
    }));
}

module.exports = {
  SERVER_PATH,
  ROOT,
  pidFilePath,
  writePidFile,
  readPidFile,
  clearPidFile,
  listProcesses,
  commandIsOurServer,
  isOurServer,
  findOurServers
};
