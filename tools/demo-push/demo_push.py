#!/usr/bin/env python3
"""Live 3D sidecar for a game box: send the growing SourceTV demo of a PUG match to the site.

Tails every `pug_<token>_<ordinal>_<map>.dem` written in the last few minutes in the given
game folders (read only) and POSTs the new bytes to /api/demos/push about once a second, in
the format src/routes/demoLive.ts documents. The match token from the file name is the
credential, as for the .rpl live push: it only travels in a header over HTTPS and is never
logged. The site holds every byte back 10 s before any viewer gets it.

Standard library only (python3 on the boxes). No state on disk: after a restart the site's
409 tells it where to resume.

    demo_push.py --dir /home/l4d/l4d1-a/left4dead --dir /home/l4d/l4d1-b/left4dead \
                 --url https://riversidepug.com/api/demos/push

docs/theatre-3d.md "Phase 2" and tools/demo-push/README.md.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

NAME_RE = re.compile(r'^pug_([0-9a-f]{32})_(\d+)_([A-Za-z0-9_.-]+)\.dem$')
HEADER_BYTES = 1072          # the whole demo header must be in the first batch
PIECE = 1024 * 1024          # the site's body limit per request
PER_TICK = 8 * PIECE         # catch up at most this much per file per pass
RECENT_S = 150               # a file untouched for longer is finished (or pulled from elsewhere)
FORGET_S = 900               # drop a file's state after this long untouched
BACKOFF_MAX = 30.0


def birth(path, fallback):
    """The file's creation time (unix s) from GNU stat's %W, so the same file keeps the same
    X-Demo-Started across sidecar restarts (a new value at offset 0 is a NEW recording to the
    site, which restarts every viewer). 0 or no answer: the fallback (first seen)."""
    try:
        out = subprocess.run(['stat', '-c', '%W', '--', path], capture_output=True, text=True, timeout=5).stdout.strip()
        v = int(out)
        return v if v > 0 else int(fallback)
    except (OSError, ValueError, subprocess.SubprocessError):
        return int(fallback)


def log(*a):
    print(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), *a, flush=True)


def label(token, ordinal, mapname):
    # never the token: its first four hex digits are enough to tell matches apart in a log
    return f'{token[:4]}.. map {ordinal} {mapname}'


class Tail:
    def __init__(self, path, token, ordinal, mapname, inode, now):
        self.path, self.token, self.ordinal, self.map = path, token, ordinal, mapname
        self.inode = inode
        self.started = birth(path, now)
        self.offset = 0
        self.dead = False          # the site will not take this recording (match over, stale)
        self.retry_at = 0.0
        self.backoff = 1.0
        self.seen = now

    def restart(self, inode, now):
        self.inode = inode
        self.started = max(self.started + 1, birth(self.path, now))
        self.offset = 0
        self.dead = False
        self.retry_at = 0.0
        self.backoff = 1.0


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: urllib would carry X-Demo-Token to wherever it points,
    another host or plain http included. A redirect is an error here."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f'redirect refused ({code})', headers, fp)


OPENER = urllib.request.build_opener(NoRedirect)


def post(url, t, offset, body, timeout):
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'Content-Type': 'application/octet-stream',
        'X-Demo-Token': t.token,
        'X-Demo-Ordinal': str(t.ordinal),
        'X-Demo-Map': t.map,
        'X-Demo-Offset': str(offset),
        'X-Demo-Started': str(t.started),
        'User-Agent': 'riverside-demo-push/1',
    })
    try:
        with OPENER.open(req, timeout=timeout) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read() or b'{}')
        except ValueError:
            data = {}
        return e.code, data


def pump(url, t, size, now, timeout):
    """Send what the site lacks of one file, up to PER_TICK bytes."""
    if t.dead or now < t.retry_at:
        return
    if size < HEADER_BYTES and t.offset == 0:
        return
    sent = 0
    with open(t.path, 'rb') as f:
        while t.offset < size and sent < PER_TICK:
            f.seek(t.offset)
            body = f.read(min(PIECE, size - t.offset))
            if not body:
                return
            try:
                status, data = post(url, t, t.offset, body, timeout)
            except (urllib.error.URLError, OSError, ValueError) as e:
                fail(t, now, f'network: {type(e).__name__}')
                return
            if status == 200:
                t.offset = int(data.get('length', t.offset + len(body)))
                t.backoff = 1.0
                sent += len(body)
            elif status == 409:
                err = data.get('error')
                if err == 'content differs':
                    # srcds re-recorded over the same name and we missed the shrink: the
                    # site's copy is a different recording. Send this one as new.
                    t.restart(t.inode, now)
                    log(label(t.token, t.ordinal, t.map), 'site has other bytes at the start: sending as a new recording')
                    return
                if err in ('stale recording', 'recorded locally'):
                    log(label(t.token, t.ordinal, t.map), f'site says {err}: not sending this recording')
                    t.dead = True
                    return
                t.offset = int(data.get('length', 0))   # resume where the site's copy ends
            elif status == 404:
                log(label(t.token, t.ordinal, t.map), 'match not live on the site: stopping this recording')
                t.dead = True
                return
            else:
                fail(t, now, f'HTTP {status}')
                return


def fail(t, now, why):
    t.retry_at = now + t.backoff
    log(label(t.token, t.ordinal, t.map), f'{why}, retry in {t.backoff:.0f} s')
    t.backoff = min(BACKOFF_MAX, t.backoff * 2)


def scan(dirs, tails, now):
    """Files written recently, as (Tail, size); new and restarted recordings noticed."""
    out = []
    for d in dirs:
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            m = NAME_RE.match(name)
            if not m:
                continue
            path = os.path.join(d, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            t = tails.get(path)
            if t is None:
                if now - st.st_mtime > RECENT_S:
                    continue
                t = Tail(path, m.group(1), int(m.group(2)), m.group(3), st.st_ino, now)
                tails[path] = t
                log(label(t.token, t.ordinal, t.map), 'following')
            elif st.st_ino != t.inode or st.st_size < t.offset:
                t.restart(st.st_ino, now)
                log(label(t.token, t.ordinal, t.map), 'new recording at the same name')
            t.seen = st.st_mtime
            out.append((t, st.st_size))
    for path in [p for p, t in tails.items() if now - t.seen > FORGET_S]:
        del tails[path]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--dir', action='append', required=True, help='a game folder holding pug_*.dem (repeatable)')
    ap.add_argument('--url', default='https://riversidepug.com/api/demos/push')
    ap.add_argument('--every', type=float, default=1.0, help='seconds between passes')
    ap.add_argument('--timeout', type=float, default=10.0)
    a = ap.parse_args()
    if not a.url.startswith('https://') and not re.match(r'^http://(127\.0\.0\.1|localhost)[:/]', a.url):
        sys.exit('refusing a non-HTTPS URL: the token is the credential')
    tails = {}
    log('watching', ', '.join(a.dir), '->', a.url)
    while True:
        now = time.time()
        for t, size in scan(a.dir, tails, now):
            if size > t.offset:
                try:
                    pump(a.url, t, size, now, a.timeout)
                except OSError as e:
                    fail(t, now, f'read: {type(e).__name__}')
        time.sleep(a.every)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
