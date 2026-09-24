#!/usr/bin/env python3
"""Minimal rcon client for the LOCAL playtest instance only (127.0.0.1:27045)."""
import re, socket, struct, sys
CFG = '/home/volence/l4d1-ds-skyprobe/server/left4dead/cfg/skyplaytest.cfg'
PW = re.search(r'rcon_password "([^"]+)"', open(CFG).read()).group(1)
def pkt(i, t, body): 
    b = struct.pack('<ii', i, t) + body.encode() + b'\x00\x00'
    return struct.pack('<i', len(b)) + b
def read(s):
    n = struct.unpack('<i', s.recv(4))[0]; d = b''
    while len(d) < n: d += s.recv(n - len(d))
    return struct.unpack('<ii', d[:8]) + (d[8:-2].decode(errors='replace'),)
s = socket.create_connection(('127.0.0.1', 27045), timeout=5)
s.sendall(pkt(1, 3, PW)); read(s)
try: s.settimeout(0.5); read(s)
except Exception: pass
s.settimeout(3)
s.sendall(pkt(2, 2, ' '.join(sys.argv[1:]))); print(read(s)[2])
