#!/usr/bin/env python3
"""Pull a second game server's PUG demos and replay files over FTP.

The site reads demos and replays off this box's disk. The Chicago server (NFO)
has no shared filesystem and no SSH, so its files are fetched here instead, and
then deleted there so its disk does not fill. The backend's re-index sweep
(src/reindex.ts) links whatever lands to its match.

Only settled files are taken: a file is pulled when its size has not changed
since the previous run, so a demo still being written is left alone. State lives
in STATE_PATH. Config in /etc/pug-chicago.env (FTP_HOST/USER/PASS, DEMO_DIR,
REPLAY_DIR). Run from pug-pull-chicago.timer.
"""
import ftplib, json, os, sys, tempfile

CONF = '/etc/pug-chicago.env'
STATE_PATH = '/var/lib/pug-pull-chicago.json'
REMOTE_DEMOS = '/left4dead'
REMOTE_REPLAYS = '/left4dead/replays'

def conf():
    out = {}
    with open(CONF) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                out[k] = v
    return out

def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

def save_state(state):
    tmp = STATE_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f)
    os.replace(tmp, STATE_PATH)

def listing(ftp, path, suffix, prefix='pug_'):
    out = {}
    try:
        lines = []
        ftp.retrlines(f'LIST {path}', lines.append)
    except ftplib.error_perm:
        return out
    for l in lines:
        parts = l.split(None, 8)
        if len(parts) < 9 or l.startswith('d'):
            continue
        name, size = parts[8], int(parts[4])
        if name.startswith(prefix) and name.endswith(suffix):
            out[name] = size
    return out

def pull(ftp, remote_dir, name, size, local_dir):
    """Download to a temp file, verify the size, move into place, delete remote."""
    os.makedirs(local_dir, exist_ok=True)
    local = os.path.join(local_dir, name)
    if os.path.exists(local) and os.path.getsize(local) == size:
        ftp.delete(f'{remote_dir}/{name}')
        return 0
    fd, tmp = tempfile.mkstemp(dir=local_dir, prefix='.pull-')
    try:
        with os.fdopen(fd, 'wb') as f:
            ftp.retrbinary(f'RETR {remote_dir}/{name}', f.write)
        if os.path.getsize(tmp) != size:
            os.unlink(tmp)
            print(f'  size mismatch, leaving {name} on the server')
            return 0
        os.replace(tmp, local)
        os.chmod(local, 0o644)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    ftp.delete(f'{remote_dir}/{name}')
    return size

def main():
    c = conf()
    state = load_state()
    ftp = ftplib.FTP(c['FTP_HOST'], timeout=120)
    ftp.login(c['FTP_USER'], c['FTP_PASS'])
    ftp.set_pasv(True)
    moved = files = 0
    new_state = {}
    for remote_dir, suffix, local_dir in (
        (REMOTE_DEMOS, '.dem', c['DEMO_DIR']),
        (REMOTE_REPLAYS, '.rpl', c['REPLAY_DIR']),
    ):
        if not local_dir:
            continue
        for name, size in listing(ftp, remote_dir, suffix).items():
            key = f'{remote_dir}/{name}'
            if state.get(key) == size and size > 0:
                try:
                    moved += pull(ftp, remote_dir, name, size, local_dir)
                    files += 1
                except Exception as e:
                    print(f'  {name}: {e}')
                    new_state[key] = size
            else:
                new_state[key] = size   # still growing; try again next run
    ftp.quit()
    save_state(new_state)
    if files:
        print(f'pulled {files} files, {moved // 1_000_000} MB from Chicago')

if __name__ == '__main__':
    sys.exit(main())
