# Hunter Training Practice Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player can start a private "Hunter Training" server from the Play page, next to the Practice Park, and play eyeonus's Hunter Training course on our servers with cheats off.

**Architecture:** A third practice lease kind, `hunter`, rides the existing lease machinery (src/practiceLeases.ts: pick an idle box, restart srcds, exec `practice_<kind>.cfg`, verify, send identity lines, restart on end). On the game side a new small plugin, `l4d_hunter_training.smx`, replaces everything the map used cheats for: it puts the owner straight on infected as a live hunter at the course start, provides `sm_ht_noclip` for the map's room-to-room carries, and keeps survivors from taking damage. A generated Stripper:Source file rewrites the map's own `sv_cheats 1` / `noclip` / `jointeam` / `z_spawn` outputs to those commands. The map ships as a custom campaign flagged `practice_only`, so it installs everywhere and is downloadable but can never enter the PUG map pool.

**Tech Stack:** TypeScript (Fastify, better-sqlite3, vitest), Preact (web, @testing-library/preact), SourcePawn 1.12 with left4dhooks (compiled with the private spcomp in `l4d/practice/build/`), Stripper:Source, Python 3 (generator).

**Spec:** this plan is its own spec; the decisions come from the owner conversation of 2026-09-28 (session notes in memory `l4d1-hunter-training-map`). Decisions, verbatim where the owner gave them:
- Host the map on all servers and in the custom campaign downloads.
- On the Play page: "if practice park is in we have join or 'start hunter training' or if neither then it's an option of picking which". Implemented as one Start button per kind with nothing open, Join on open parks.
- Keep it out of the PUG rotation; credit the author (eyeonus).
- Local test first; nothing goes live without the owner's go-ahead ([[live-server-no-unasked-changes]]).

## Global Constraints

- No em dashes anywhere: code, comments, docs, commit messages, UI copy. Use a colon, comma, parentheses or a new sentence.
- Never deploy, restart or rcon a live server without the owner's explicit go-ahead. Tasks 1 to 8 are local only.
- The local test server `/home/volence/l4d1-ds` is shared: run the hunter test on its own port (27055), check `status` for humans before restarting anything, kill srcds by PID only.
- `sv_cheats` must stay 0 on a hunter lease the whole time, and Mathack Block (`l4d_texture_manager_block.smx`) must stay loaded.
- One human plays a Hunter Training server. A second human is moved to spectator with a message.
- Phase 1 is Training Grounds (`hunter_training_map`) only. The Live Fire Course (`hunter_training_c21`) is switched off by the stripper file; finishing the last room says "Course complete" and returns the hunter to the start.
- In-game menus: 5 items at most (L4D1 binds only keys 1 to 5).
- pug repo: `npm test` (vitest) and `npx tsc --noEmit` must pass before each commit. Another session may be committing to pug master: check `git status` and `git reflog -5` before any git write, and work on branch `hunter-training`.
- SourcePawn build: `cd /home/volence/l4d/practice && ./build.sh` pattern (wine + `build/spcomp.exe`, includes in `build/include`).

## Review Focus

1. **A player who dies, falls out, or somehow ends up a ghost or survivor** expects to be put back on the course as a live hunter within about two seconds. Covered by Task 2's respawn timer and the Task 4 in-game check list (deliberately fall off a course and suicide with `kill`).
2. **A second person joins with the invite link** and expects to be told the server is in use rather than get a broken course. Covered by Task 2 (spectator move) and Task 6 (connect line only for owner and admins).
3. **A map change on the lease** (the per-map cfg re-exec, or an admin changelevel) must not lose the password or the cheats-off state. Covered by Task 2's password enforcement on OnConfigsExecuted and Task 4's check after `changelevel hunter_training_map`.
4. **An admin ticking Hunter Training into the PUG pool** must be impossible. Covered by Task 7's poolableCampaigns test and a PUT to `map_pool` being refused.
5. **An existing database with park and drill rows** must migrate to the wider `kind` check without losing rows. Covered by Task 5's migration test.

---

## File Structure

Game side, repo `/home/volence/l4d/practice` (its own git):
- Create `hunter/make_stripper.py`: reads the BSP entity lump, writes the Stripper cfg. One job: map I/O rewrite.
- Create `hunter/test_make_stripper.py`: unittest for the generator.
- Create `hunter/hunter_training_map.bsp.sha256`: the sha256 of the BSP the cfg was generated from, so a future map update is noticed.
- Create `proposed-cfg/stripper/hunter_training_map.cfg`: generated output, committed.
- Create `l4d_hunter_training.sp`: the plugin.
- Modify `build.sh`: build both plugins.
- Create `proposed-cfg/practice_hunter.cfg`, `proposed-cfg/practice_hunter_map.cfg`.

Site, repo `/home/volence/l4d/pug`, branch `hunter-training`:
- Modify `src/db.ts`: widen `practice_leases.kind`, add `custom_campaigns.practice_only`.
- Modify `src/practiceLeases.ts`: kind `hunter`, per-kind config check, identity lines, owned-lease rule, hunter listings.
- Modify `src/routes/practice.ts`: accept `hunter`, list hunter servers.
- Modify `src/customCampaigns.ts`, `src/campaignRegistry.ts`, `src/routes/campaigns.ts`: practice-only flag.
- Modify `web/src/api.ts`, `web/src/practice.ts`, `web/src/components/PracticeCard.tsx`, `web/src/routes/Practice.tsx`, `web/src/routes/CustomCampaigns.tsx`, `web/src/routes/admin/AdminCampaigns.tsx`.
- Tests: `tests/db.test.ts`, `tests/practiceLeases.test.ts`, `tests/practiceRoutes.test.ts`, `tests/campaignRegistry.test.ts`, `tests/campaignRoutes.test.ts`, `web/src/components/PracticeCard.test.tsx`.

Deploy, repo `/home/volence/l4d/deploy` (Task 9, owner go-ahead only):
- `overrides/left4dead/addons/sourcemod/plugins/optional/l4d_hunter_training.smx`
- `overrides/left4dead/cfg/practice_hunter.cfg`, `overrides/left4dead/cfg/practice_hunter_map.cfg`
- `overrides/left4dead/addons/stripper/Roto-AZMod/maps/hunter_training_map.cfg`

---

### Task 1: Stripper file generator

The map fires cheat commands through `point_servercommand` (named `server`) and `point_clientcommand` (named `client`). This generator rewrites every one of them by a fixed rule table and refuses to run if it meets a command it has no rule for, so a map update can never silently bring a cheat back. Entities are matched on classname + hammerid + origin because hammerid alone repeats in this map (1258 and 1333 are each used twice).

**Files:**
- Create: `/home/volence/l4d/practice/hunter/make_stripper.py`
- Create: `/home/volence/l4d/practice/hunter/test_make_stripper.py`
- Create: `/home/volence/l4d/practice/hunter/hunter_training_map.bsp.sha256`
- Create: `/home/volence/l4d/practice/proposed-cfg/stripper/hunter_training_map.cfg`

**Interfaces:**
- Produces: console commands the plugin (Task 2) must register: `sm_ht_noclip <0|1>`, `sm_ht_spawnme`, `sm_ht_finish`. The cvar line `sm_cvar nb_stop 1` needs nothing new.

- [ ] **Step 1: Get the BSP out of the VPK**

The VPK is `/home/volence/Downloads/l4d_hunter_training_1.0.zip` (one file, `hunter_training[1].vpk`, 221841973 bytes). Extract the BSP with this one-off script into `/tmp/claude-1000/-home-volence-l4d/<session>/scratchpad/` (any scratch dir; never commit the BSP, it is 14.6 MB):

```bash
cd "$SCRATCH" && unzip -o -q /home/volence/Downloads/l4d_hunter_training_1.0.zip && python3 - <<'EOF'
import struct
f = open('hunter_training[1].vpk', 'rb')
sig, ver, tree = struct.unpack('<III', f.read(12))
assert sig == 0x55aa1234 and ver == 1
def s():
    b = b''
    while (c := f.read(1)) != b'\0': b += c
    return b.decode()
files = {}
while (ext := s()):
    while (path := s()):
        while (name := s()):
            crc, pre, arch, off, ln, term = struct.unpack('<IHHIIH', f.read(18))
            files[f'{path}/{name}.{ext}'] = (off, ln, f.read(pre))
off, ln, pre = files['maps/hunter_training_map.bsp']
f.seek(12 + tree + off)
open('hunter_training_map.bsp', 'wb').write(pre + f.read(ln))
EOF
sha256sum hunter_training_map.bsp
```

Expected: a 14629484-byte `hunter_training_map.bsp` starting with `VBSP` version 20. Write its sha256 line into `hunter/hunter_training_map.bsp.sha256`.

- [ ] **Step 2: Write the failing test**

`/home/volence/l4d/practice/hunter/test_make_stripper.py`:

```python
import os, struct, unittest
from make_stripper import generate, RULES

def fake_bsp(entities: str) -> bytes:
    """A BSP whose lump 0 (entities) is `entities`; header is 8 bytes then 64 lumps of 16."""
    body = entities.encode('latin-1') + b'\0'
    header = b'VBSP' + struct.pack('<i', 20)
    lumps = struct.pack('<iiii', 8 + 64 * 16 + 4, len(body), 0, 0) + b'\0' * (63 * 16)
    return header + lumps + struct.pack('<i', 1) + body

LOOK = '''{
"classname" "trigger_look"
"hammerid" "1240"
"origin" "-719.98 -0.01 63"
"targetname" "start_room_zombie"
"OnTrigger" "server,Command,sv_cheats 1,0,1"
"OnTrigger" "server,Command,nb_stop 1,0.5,-1"
"OnTrigger" "client,Command,jointeam 3,2,-1"
"OnTrigger" "c13_train,StartForward,,3,-1"
}'''
END = '''{
"classname" "trigger_multiple"
"hammerid" "1564"
"origin" "3168 136 2240"
"targetname" "challenge_21_level_change"
"OnStartTouch" "server,Command,changelevel hunter_training_c21,0.02,-1"
"OnStartTouch" "server,Command,nb_stop 0,0,-1"
}'''

class GenerateTest(unittest.TestCase):
    def test_drops_cheats_and_rewrites_the_rest(self):
        cfg = generate(fake_bsp(LOOK))
        self.assertIn('"hammerid" "1240"', cfg)
        self.assertIn('"origin" "-719.98 -0.01 63"', cfg)
        insert = cfg.split('insert:')[1]
        self.assertIn('"OnTrigger" "server,Command,sm_cvar nb_stop 1,0.5,-1"', insert)
        self.assertNotIn('sv_cheats', insert)
        self.assertNotIn('jointeam', insert)
        # The train start is not a Command output and is left alone.
        self.assertNotIn('c13_train', cfg)

    def test_live_fire_changelevel_becomes_finish(self):
        cfg = generate(fake_bsp(END))
        insert = cfg.split('insert:')[1]
        self.assertIn('"OnStartTouch" "client,Command,sm_ht_finish,0,-1"', insert)
        self.assertNotIn('changelevel', insert)

    def test_refuses_an_unknown_command(self):
        with self.assertRaises(SystemExit) as e:
            generate(fake_bsp(LOOK.replace('nb_stop 1', 'impulse 101')))
        self.assertIn('impulse 101', str(e.exception))

    def test_every_rule_target_is_server_or_client(self):
        self.assertTrue(all(t in ('server', 'client') for t, _ in RULES))

class RealMapTest(unittest.TestCase):
    """Runs only when HT_BSP points at the real hunter_training_map.bsp."""
    @unittest.skipUnless(os.environ.get('HT_BSP'), 'set HT_BSP to the extracted BSP')
    def test_no_cheat_survives_in_any_insert(self):
        cfg = generate(open(os.environ['HT_BSP'], 'rb').read())
        inserts = ''.join(block.split('insert:')[1] for block in cfg.split('modify:') if 'insert:' in block)
        for bad in ('sv_cheats', 'Command,noclip', 'jointeam', 'z_spawn', 'god 1', 'changelevel', 'sb_all_bot_game'):
            self.assertNotIn(bad, inserts, bad)
        # 7 `noclip 1` and 8 `noclip 0` outputs in the real map, one insert each.
        self.assertEqual(inserts.count('sm_ht_noclip'), 15)
        self.assertIn('sm_ht_spawnme', inserts)
        self.assertIn('sm_ht_finish', inserts)

if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd /home/volence/l4d/practice/hunter && python3 -m unittest test_make_stripper -v`
Expected: `ModuleNotFoundError: No module named 'make_stripper'`.

- [ ] **Step 4: Write the generator**

`/home/volence/l4d/practice/hunter/make_stripper.py`:

```python
#!/usr/bin/env python3
"""Stripper:Source cfg for hunter_training_map that takes every cheat out of the map's I/O.

The map (eyeonus, gamemaps.com/details/5549) was built for a listen server with sv_cheats 1:
its triggers run `sv_cheats 1`, `god 1`, `noclip`, `jointeam 3` and `z_spawn hunter` through a
point_servercommand named `server` and a point_clientcommand named `client`. On our servers
Mathack Block kicks anyone with sv_cheats on, so each of those outputs is rewritten by RULES to a
command l4d_hunter_training.smx provides, or dropped. A command with no rule stops the generator:
a map update must never slip a cheat back in unnoticed.

Entities are matched on classname + hammerid + origin: hammerid alone repeats in this map.

    python3 make_stripper.py hunter_training_map.bsp > ../proposed-cfg/stripper/hunter_training_map.cfg
"""
import re, struct, sys

DROP = None
# (target, command) -> replacement command on the same target, or DROP.
RULES = {
    ('server', 'sv_cheats 1'): DROP,
    ('server', 'god 1'): DROP,                      # the plugin makes survivors take no damage
    ('server', 'vs_max_team_switches 1000'): DROP,  # the plugin owns teams
    ('server', 'sb_all_bot_team 1'): DROP,          # set in practice_hunter_map.cfg
    ('server', 'sb_all_bot_game 1'): DROP,          # an L4D2 cvar, unknown on L4D1
    ('server', 'l4d2_htm_mp_enable 1'): DROP,       # the author's L4D2 plugin, not ours
    ('server', 'nb_stop 1'): 'sm_cvar nb_stop 1',
    ('server', 'nb_stop 0'): DROP,                  # only on the Live Fire changelevel trigger
    ('server', 'changelevel hunter_training_c21'): DROP,  # phase 1: Live Fire Course is off
    ('client', 'noclip 1'): 'sm_ht_noclip 1',
    ('client', 'noclip 0'): 'sm_ht_noclip 0',
    ('client', 'z_spawn hunter'): 'sm_ht_spawnme',  # the spawn pad: a ghost becomes a live hunter
    ('client', 'jointeam 3'): DROP,                 # the plugin puts players on infected
    ('client', 'cmd2 jointeam 3'): DROP,
}
# Outputs added to one entity, keyed by its targetname.
EXTRA = {
    'challenge_21_level_change': [('OnStartTouch', 'client,Command,sm_ht_finish,0,-1')],
}


def entities(bsp: bytes):
    off, ln = struct.unpack_from('<ii', bsp, 8)
    text = bsp[off:off + ln].decode('latin-1')
    for block in re.findall(r'\{[^{}]*\}', text):
        yield re.findall(r'"([^"]*)" "([^"]*)"', block)


def generate(bsp: bytes) -> str:
    out = ['; Generated by hunter/make_stripper.py. Do not edit by hand: change RULES and regenerate.']
    unknown = set()
    for kv in entities(bsp):
        d = dict(kv)
        dels, ins = [], []
        for k, v in kv:
            if not k.startswith('On'):
                continue
            p = v.split(',')
            if len(p) < 3 or p[1] != 'Command' or p[0] not in ('server', 'client'):
                continue
            key = (p[0], p[2])
            if key not in RULES:
                unknown.add(key)
                continue
            dels.append((k, v))
            if RULES[key] is not DROP:
                ins.append((k, ','.join([p[0], p[1], RULES[key]] + p[3:])))
        ins += EXTRA.get(d.get('targetname', ''), [])
        if not dels and not ins:
            continue
        out.append('modify:\n{\n\tmatch:\n\t{')
        for k in ('classname', 'hammerid', 'origin'):
            out.append('\t\t"%s" "%s"' % (k, d[k]))
        out.append('\t}')
        if dels:
            out.append('\tdelete:\n\t{')
            out += ['\t\t"%s" "%s"' % pair for pair in dels]
            out.append('\t}')
        if ins:
            out.append('\tinsert:\n\t{')
            out += ['\t\t"%s" "%s"' % pair for pair in ins]
            out.append('\t}')
        out.append('}')
    if unknown:
        sys.exit('no rule for: %s' % sorted(unknown))
    return '\n'.join(out) + '\n'


if __name__ == '__main__':
    sys.stdout.write(generate(open(sys.argv[1], 'rb').read()))
```

- [ ] **Step 5: Run the tests, then generate the real file**

Run: `cd /home/volence/l4d/practice/hunter && python3 -m unittest test_make_stripper -v && HT_BSP=$SCRATCH/hunter_training_map.bsp python3 -m unittest test_make_stripper -v`
Expected: all pass, RealMapTest not skipped the second time.

Run: `mkdir -p ../proposed-cfg/stripper && python3 make_stripper.py $SCRATCH/hunter_training_map.bsp > ../proposed-cfg/stripper/hunter_training_map.cfg && grep -c '^modify' ../proposed-cfg/stripper/hunter_training_map.cfg`
Expected: `11` (the count seen when this plan was written; a different number means the map is not the one this plan was written against).

- [ ] **Step 6: Commit**

```bash
cd /home/volence/l4d/practice
git add hunter/make_stripper.py hunter/test_make_stripper.py hunter/hunter_training_map.bsp.sha256 proposed-cfg/stripper/hunter_training_map.cfg
git commit -m "Hunter Training: stripper generator that rewrites the map's cheat commands"
```

---

### Task 2: The l4d_hunter_training plugin

What the map used cheats for, done by a plugin, plus the join flow. Proven pieces: the throwaway probe of 2026-09-28 (`ChangeClientTeam` 3, `L4D_State_Transition(c, 8)`, `L4D_SetClass(c, 3)`, teleport, `L4D_MaterializeFromGhost`, teleport again) put the owner on the course as a live hunter; the owner check and password enforcement are copied from `l4d_practice.sp` (`IsDrillOwner` at line 490, `EnforcePassword` at line 4257).

**Files:**
- Create: `/home/volence/l4d/practice/l4d_hunter_training.sp`
- Modify: `/home/volence/l4d/practice/build.sh`

**Interfaces:**
- Consumes: the commands from Task 1 (`sm_ht_noclip`, `sm_ht_spawnme`, `sm_ht_finish`).
- Produces for Task 3 and the site (Task 6): cvars `l4d_ht_enable` (0/1), `l4d_ht_password` (string), `l4d_ht_owner` (SteamID64 string or empty). Server command `sm_ht_who` printing lines that start `HTWHO` and `HT enable=`.

- [ ] **Step 1: Write the plugin**

`/home/volence/l4d/practice/l4d_hunter_training.sp`:

```sourcepawn
// l4d_hunter_training: runs eyeonus's Hunter Training map (gamemaps.com/details/5549) with cheats off.
//
// The map was built for sv_cheats 1: it moved players between rooms with noclip, made them hunters
// with z_spawn and joined them to infected with jointeam. The stripper file generated by
// hunter/make_stripper.py rewrites those outputs to the sm_ht_* commands below. On top of that this
// plugin skips the map's survivor lobby and spawn pad: the one player is put straight on the course
// as a live hunter, and put back there on death. Inert unless l4d_ht_enable is 1.
#include <sourcemod>
#include <sdktools>
#include <sdkhooks>
#include <left4dhooks>

#define TEAM_SPECTATOR 1
#define TEAM_SURVIVOR 2
#define TEAM_INFECTED 3
#define ZC_HUNTER 3
#define STATE_GHOST 8

public Plugin myinfo =
{
	name = "L4D1 Hunter Training",
	author = "Riverside",
	description = "Hunter Training map without sv_cheats",
	version = "1.0.0",
	url = "https://riversidepug.com"
};

ConVar g_cvEnable;
ConVar g_cvPassword;
ConVar g_cvOwner;
float g_vStart[3];
bool g_bHaveStart;

public void OnPluginStart()
{
	g_cvEnable = CreateConVar("l4d_ht_enable", "0", "1 on a Hunter Training lease", FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvPassword = CreateConVar("l4d_ht_password", "", "Lease password, re-applied after every map load", FCVAR_PROTECTED);
	g_cvOwner = CreateConVar("l4d_ht_owner", "", "SteamID64 of the lease owner; empty lets anyone play");

	RegConsoleCmd("sm_ht_noclip", Cmd_Noclip, "Map output: noclip on (1) or off (0) for the activator");
	RegConsoleCmd("sm_ht_spawnme", Cmd_SpawnMe, "Map output: the spawn pad; put the activator on the course");
	RegConsoleCmd("sm_ht_finish", Cmd_Finish, "Map output: the last room was cleared");
	RegConsoleCmd("sm_course", Cmd_Course, "!course: back to the start of the course");
	RegServerCmd("sm_ht_who", SrvCmd_Who, "Team, class, state and position of every human");

	AddCommandListener(Listen_JoinTeam, "jointeam");
	HookEvent("player_death", Ev_Death);

	for (int i = 1; i <= MaxClients; i++)
		if (IsClientInGame(i)) OnClientPutInServer(i);
}

// ---------------------------------------------------------------- map and password

public void OnMapStart()
{
	g_bHaveStart = FindDestination("start_room", g_vStart);
}

// The start of the course: the map's own info_teleport_destination "start_room".
bool FindDestination(const char[] name, float pos[3])
{
	int ent = -1;
	char n[64];
	while ((ent = FindEntityByClassname(ent, "info_teleport_destination")) != -1)
	{
		GetEntPropString(ent, Prop_Data, "m_iName", n, sizeof(n));
		if (StrEqual(n, name))
		{
			GetEntPropVector(ent, Prop_Send, "m_vecOrigin", pos);
			return true;
		}
	}
	return false;
}

public void OnConfigsExecuted()
{
	EnforcePassword();
	CreateTimer(1.0, Timer_EnforcePassword, _, TIMER_FLAG_NO_MAPCHANGE);
}

public Action Timer_EnforcePassword(Handle timer)
{
	EnforcePassword();
	return Plugin_Stop;
}

// server.cfg's secrets.cfg restores the standing password on every map load; the lease's wins.
void EnforcePassword()
{
	if (!g_cvEnable.BoolValue) return;
	char want[64], have[64];
	g_cvPassword.GetString(want, sizeof(want));
	if (want[0] == '\0') return;
	ConVar pw = FindConVar("sv_password");
	if (pw == null) return;
	pw.GetString(have, sizeof(have));
	if (!StrEqual(want, have)) pw.SetString(want);
}

// ---------------------------------------------------------------- who plays

bool IsHuman(int client)
{
	return client > 0 && client <= MaxClients && IsClientInGame(client) && !IsFakeClient(client);
}

// Copied from l4d_practice.sp IsDrillOwner: SteamID64's low 32 bits are the account id, and
// GetSteamAccountID fails under sv_lan, where Steam2 is converted by hand.
bool IsOwner(int client)
{
	char owner[32];
	g_cvOwner.GetString(owner, sizeof(owner));
	if (owner[0] == '\0') return true;
	int v[2];
	StringToInt64(owner, v);
	int acct = GetSteamAccountID(client, false);
	if (acct == 0)
	{
		char s2[32];
		if (GetClientAuthId(client, AuthId_Steam2, s2, sizeof(s2), false))
		{
			char parts[3][16];
			if (ExplodeString(s2, ":", parts, 3, 16) == 3) acct = StringToInt(parts[2]) * 2 + StringToInt(parts[1]);
		}
	}
	return acct != 0 && acct == v[0];
}

// With no owner set (local testing), the first human on infected plays and the rest watch.
bool SomeoneElsePlays(int client)
{
	for (int i = 1; i <= MaxClients; i++)
		if (i != client && IsHuman(i) && GetClientTeam(i) == TEAM_INFECTED) return true;
	return false;
}

bool MayPlay(int client)
{
	char owner[32];
	g_cvOwner.GetString(owner, sizeof(owner));
	if (owner[0] != '\0') return IsOwner(client);
	return !SomeoneElsePlays(client);
}

public void OnClientPutInServer(int client)
{
	SDKHook(client, SDKHook_OnTakeDamage, OnTakeDamage);
	if (g_cvEnable.BoolValue && IsHuman(client))
		CreateTimer(1.0, Timer_Place, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
}

public Action Timer_Place(Handle timer, int userid)
{
	int client = GetClientOfUserId(userid);
	if (!IsHuman(client)) return Plugin_Stop;
	if (!MayPlay(client))
	{
		ChangeClientTeam(client, TEAM_SPECTATOR);
		PrintToChat(client, "\x04[Hunter Training]\x01 This server is in use. Start your own from the Play page on the site.");
		return Plugin_Stop;
	}
	PutOnCourse(client);
	PrintToChat(client, "\x04[Hunter Training]\x01 You are a hunter at the start of the course. \x05!course\x01 brings you back here.");
	return Plugin_Stop;
}

// ---------------------------------------------------------------- the course

// Infected, a live hunter (not a ghost), standing at the course start.
void PutOnCourse(int client)
{
	if (!g_bHaveStart) g_bHaveStart = FindDestination("start_room", g_vStart);
	if (!g_bHaveStart)
	{
		PrintToServer("HTERR no info_teleport_destination named start_room on this map");
		return;
	}
	if (GetClientTeam(client) != TEAM_INFECTED) ChangeClientTeam(client, TEAM_INFECTED);
	if (!IsPlayerAlive(client) || GetEntProp(client, Prop_Send, "m_zombieClass") != ZC_HUNTER)
		L4D_State_Transition(client, STATE_GHOST);
	if (IsPlayerAlive(client) && GetEntProp(client, Prop_Send, "m_isGhost") == 1)
	{
		L4D_SetClass(client, ZC_HUNTER);
		TeleportEntity(client, g_vStart, NULL_VECTOR, view_as<float>({ 0.0, 0.0, 0.0 }));
		L4D_MaterializeFromGhost(client);
	}
	SetEntityMoveType(client, MOVETYPE_WALK);
	TeleportEntity(client, g_vStart, NULL_VECTOR, view_as<float>({ 0.0, 0.0, 0.0 }));
}

public void Ev_Death(Event event, const char[] name, bool dontBroadcast)
{
	if (!g_cvEnable.BoolValue) return;
	int client = GetClientOfUserId(event.GetInt("userid"));
	if (IsHuman(client) && GetClientTeam(client) == TEAM_INFECTED)
		CreateTimer(1.5, Timer_Respawn, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
}

public Action Timer_Respawn(Handle timer, int userid)
{
	int client = GetClientOfUserId(userid);
	if (IsHuman(client) && GetClientTeam(client) == TEAM_INFECTED) PutOnCourse(client);
	return Plugin_Stop;
}

// The map carries the hunter between rooms with a short noclip; this is that, without sv_cheats.
public Action Cmd_Noclip(int client, int args)
{
	if (!g_cvEnable.BoolValue || !IsHuman(client) || !IsPlayerAlive(client)) return Plugin_Handled;
	char a[4];
	GetCmdArg(1, a, sizeof(a));
	SetEntityMoveType(client, StringToInt(a) == 1 ? MOVETYPE_NOCLIP : MOVETYPE_WALK);
	return Plugin_Handled;
}

public Action Cmd_SpawnMe(int client, int args)
{
	if (g_cvEnable.BoolValue && IsHuman(client) && MayPlay(client)) PutOnCourse(client);
	return Plugin_Handled;
}

public Action Cmd_Finish(int client, int args)
{
	if (!g_cvEnable.BoolValue || !IsHuman(client)) return Plugin_Handled;
	PrintToChat(client, "\x04[Hunter Training]\x01 Course complete! Back to the start in 3 seconds.");
	CreateTimer(3.0, Timer_Respawn, GetClientUserId(client), TIMER_FLAG_NO_MAPCHANGE);
	return Plugin_Handled;
}

public Action Cmd_Course(int client, int args)
{
	if (g_cvEnable.BoolValue && IsHuman(client) && GetClientTeam(client) == TEAM_INFECTED) PutOnCourse(client);
	return Plugin_Handled;
}

// Teams are the plugin's: the player stays a hunter, a watcher stays a watcher.
public Action Listen_JoinTeam(int client, const char[] command, int argc)
{
	if (!g_cvEnable.BoolValue || !IsHuman(client)) return Plugin_Continue;
	PrintToChat(client, "\x04[Hunter Training]\x01 Teams are fixed here. \x05!course\x01 goes back to the start.");
	return Plugin_Handled;
}

// The map expects immortal survivor bots (it ran `god 1`): pounces land, nobody dies.
public Action OnTakeDamage(int victim, int &attacker, int &inflictor, float &damage, int &damagetype)
{
	if (!g_cvEnable.BoolValue || victim < 1 || victim > MaxClients || !IsClientInGame(victim)) return Plugin_Continue;
	if (GetClientTeam(victim) != TEAM_SURVIVOR) return Plugin_Continue;
	damage = 0.0;
	return Plugin_Changed;
}

// ---------------------------------------------------------------- debug

public Action SrvCmd_Who(int args)
{
	PrintToServer("HT enable=%d start=%d at %.0f %.0f %.0f", g_cvEnable.IntValue, g_bHaveStart, g_vStart[0], g_vStart[1], g_vStart[2]);
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsHuman(i)) continue;
		float p[3];
		GetClientAbsOrigin(i, p);
		PrintToServer("HTWHO %N team=%d alive=%d ghost=%d zc=%d move=%d owner=%d pos=%.0f,%.0f,%.0f",
			i, GetClientTeam(i), IsPlayerAlive(i), GetEntProp(i, Prop_Send, "m_isGhost"),
			GetEntProp(i, Prop_Send, "m_zombieClass"), GetEntityMoveType(i), IsOwner(i), p[0], p[1], p[2]);
	}
	return Plugin_Handled;
}
```

- [ ] **Step 2: Build both plugins from build.sh**

Replace the body of `/home/volence/l4d/practice/build.sh` after `cd "$(dirname "$0")"` with a loop:

```bash
for p in l4d_practice l4d_hunter_training; do
  cp "$p.sp" "build/$p.sp"
  (cd build && wine ./spcomp.exe "$p.sp" -o "$p.smx" -iinclude 2>&1 | grep -v "^wine\|fixme\|^$\|MESA\|pci id" )
  mv "build/$p.smx" . && rm -f "build/$p.sp"
done
ls -la l4d_practice.smx l4d_hunter_training.smx
```

Update the header comment to "Compile the practice plugins (l4d_practice, l4d_hunter_training) with a private copy ...".

- [ ] **Step 3: Compile**

Run: `cd /home/volence/l4d/practice && ./build.sh`
Expected: both `.smx` files listed, no `error` lines (the `halflife.inc` CreateDialog deprecation warning is expected and harmless).

- [ ] **Step 4: Commit**

```bash
git add l4d_hunter_training.sp build.sh
git commit -m "Hunter Training plugin: live hunter at the course start, sm_ht_noclip, immortal survivors, owner-only play"
```

(The `.smx` files are build output; follow whatever the repo does with `l4d_practice.smx` today, `git status` shows whether it is tracked.)

---

### Task 3: Practice cfgs for the hunter lease

The site execs `practice_<kind>.cfg`, so this kind's cfg is `practice_hunter.cfg`. It mirrors `practice_park.cfg`: the Rotoblin practice base, then a per-map cfg that l4dready re-execs on every map. The site verifies the cfg took by reading `l4d_game_type_name` (must contain `Hunter Training`) and `l4d_ht_enable` (must be `1`), see Task 6.

**Files:**
- Create: `/home/volence/l4d/practice/proposed-cfg/practice_hunter.cfg`
- Create: `/home/volence/l4d/practice/proposed-cfg/practice_hunter_map.cfg`

- [ ] **Step 1: Write practice_hunter.cfg**

```
//=========================================
// practice_hunter.cfg - exec'd by the site when it leases a server for Hunter Training.
// Keep pure ASCII. The site then sets sv_password, l4d_ht_password and l4d_ht_owner.
//=========================================
exec rotoblin_practice.cfg
l4d_ready_server_cfg "practice_hunter_map.cfg"
// The site restarts srcds before exec'ing this; this puts the box on the course map.
changelevel hunter_training_map
```

- [ ] **Step 2: Write practice_hunter_map.cfg**

```
//=========================================
// practice_hunter_map.cfg - per-map settings for Hunter Training (l4dready re-execs this).
// Cheats stay OFF: the map's cheat outputs are rewritten by
// addons/stripper/Roto-AZMod/maps/hunter_training_map.cfg and served by l4d_hunter_training.
//=========================================
exec rotoblin_practice_map.cfg
//-----------------------------------------
// The survivors are the map's four target bots: all bots, never shooting or shoving,
// and a wipe never ends the round.
sm_cvar sb_all_bot_team 1
sm_cvar sb_dont_shoot 1
sm_cvar sb_dont_bash 1
sm_cvar director_no_death_check 1
// Nothing but the course: no director infected, commons or bosses.
sm_cvar director_no_specials 1
sm_cvar director_no_mobs 1
sm_cvar director_no_bosses 1
sm_cvar z_common_limit 0
// The map's own spawn pad sits within the start area and next to the survivor lobby.
sm_cvar z_spawn_safety_range 0
// Live hunter numbers, as in practice_park_map.cfg (live balance inventory 2026-09-28).
sm_cvar z_pounce_damage 2
sm_cvar pounceuncap_maxdamage 35
sm_cvar z_pounce_damage_range_max 1480
sm_cvar z_hunter_max_pounce_bonus_damage 34
sm_cvar hunter_pz_claw_dmg 6
// Never ranked, never flagged, never recorded.
sm_cvar sm_pug_auto_track 0
sm_cvar lilac_bhop 0
sm_cvar sm_pug_replay_standalone 0
//-----------------------------------------
exec practice_local_extras.cfg
sm plugins load_unlock
sm plugins unload optional/l4d_practice.smx
sm plugins unload optional/l4dinfectedbots.smx
sm plugins load optional/l4d_hunter_training.smx
sm plugins load_lock
sm_cvar l4d_ht_enable 1
// Last, so it wins over anything the base cfgs set.
sm_cvar l4d_game_type_name "Hunter Training"
```

- [ ] **Step 3: Check every cvar exists on the local server**

With the Task 4 server up on 27055, run each cvar name from the file as an rcon command and confirm each answers with a value (an `Unknown command` means a typo or a cvar L4D1 lacks; delete that line and note it in the commit).

- [ ] **Step 4: Commit**

```bash
git add proposed-cfg/practice_hunter.cfg proposed-cfg/practice_hunter_map.cfg
git commit -m "Hunter Training lease cfgs: cheats off, bots as targets, live hunter numbers"
```

---

### Task 4: Local end-to-end check (owner in the loop)

Everything above, on the local box, cheats off, with the owner playing. Nothing is deployed.

**Files:**
- Copy into `/home/volence/l4d1-ds/server/left4dead/`: `addons/sourcemod/plugins/optional/l4d_hunter_training.smx`, `cfg/practice_hunter.cfg`, `cfg/practice_hunter_map.cfg`, `addons/stripper/Roto-AZMod/maps/hunter_training_map.cfg`. The VPK is already at `addons/hunter_training.vpk` (copied 2026-09-28).

- [ ] **Step 1: Stop the 2026-09-28 test server on 27055**

That server has Mathack Block unloaded and `sv_cheats 1`. Check `status` over rcon on 27055 (the scratchpad `rcon.py` with `RPORT=27055`, or a copy of `/home/volence/l4d1-ds/rcon-local.py` with the port changed). If humans is 0, kill it by PID (`pgrep -af 'srcds_linux.*-port 27055'`, then `kill <pid>`). Remove the probe: `rm /home/volence/l4d1-ds/server/left4dead/addons/sourcemod/plugins/disabled/ht_probe.smx`.

- [ ] **Step 2: Start a clean server on 27055 and exec the lease cfg**

```bash
cd /home/volence/l4d1-ds/server
nohup ./srcds_run -console -game left4dead -ip 0.0.0.0 -port 27055 -tickrate 100 -maxplayers 31 -norestart +log on +sv_lan 1 +exec server +map l4d_vs_hospital01_apartment > "$SCRATCH/ht-console.log" 2>&1 &
```

Wait for rcon to answer (poll `status` until it prints `map`), wait for `l4d_game_type_name` to contain `Pub`, then send `exec practice_hunter.cfg`, wait 20 s, then send `sm_cvar sv_password ""`.

Expected, each checked over rcon:
- `status` map line: `hunter_training_map`
- `l4d_game_type_name` contains `Hunter Training`; `l4d_ht_enable` is `1`
- `sv_cheats` is `0`
- `sm plugins info l4d_texture_manager_block` shows it loaded
- `sm_ht_who` prints `HT enable=1 start=1 at -189 431 -583`

- [ ] **Step 3: Owner plays; watch from rcon**

Owner runs `sv_cheats 0` in their console first (their client still holds 1 from 2026-09-28), then `connect 192.168.4.85:27055`. Check with `sm_ht_who`: `team=3 alive=1 ghost=0 zc=3` at the course start. Ask the owner to:
1. Play rooms 1 to 15 in order. Any room where the carry to the next room fails is a Task 1 rule or Task 2 noclip bug: note the room and the `sm_ht_who` position.
2. Fall off a course deliberately, and type `kill` once: back on the course as a live hunter within about 2 s each time.
3. Try `jointeam 2` and the M-menu team switch: refused with the chat line.
4. Type `!course`: back at the start.
5. Reach the end: "Course complete!", then back at the start. No map change.

- [ ] **Step 4: Second player and map change**

- With the owner on, set `l4d_ht_owner` to a SteamID64 that is not theirs, reconnect them: they land in spectator with "This server is in use". Set it back to empty.
- `changelevel hunter_training_map` over rcon: after the map loads, `sv_cheats` is 0, `l4d_ht_enable` 1, and the owner is put back on the course.

- [ ] **Step 5: Record the result**

Update memory `l4d1-hunter-training-map` with what passed and any room that failed. Fix failures in Tasks 1 to 3 before moving on (regenerate the stripper cfg with a new rule rather than hand-editing it).

---

### Task 5: Database: a third lease kind and the practice-only flag

`practice_leases.kind` has `CHECK (kind IN ('park','drill'))`. SQLite cannot alter a CHECK, so an existing table is rebuilt once (create new, copy, drop old, rename; the standard SQLite procedure). No other table references `practice_leases`, so turning foreign keys off for the rebuild is safe.

**Files:**
- Modify: `/home/volence/l4d/pug/src/db.ts` (the practice_leases block near line 1566, and a new helper next to `ensureColumn` near line 955)
- Test: `/home/volence/l4d/pug/tests/db.test.ts`

**Interfaces:**
- Produces: `practice_leases.kind` accepts `'hunter'`; `custom_campaigns.practice_only INTEGER NOT NULL DEFAULT 0`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/db.test.ts` (it already imports `openDb`; add `import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';` at the top if absent):

```ts
describe('practice_leases kinds', () => {
  it('a new database takes hunter leases', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO players (steamid, name) VALUES ('76561199000000001', 'me')").run();
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES ('a', 'h', 27015, 27015, 'x')").run();
    expect(() => db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
      VALUES (1, 'hunter', '76561199000000001', 'x', 'x')`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
      VALUES (1, 'nonsense', '76561199000000001', 'x', 'x')`).run()).toThrow(/CHECK/);
  });

  it('an existing park/drill table is widened with its rows kept', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pugdb-')), 'pug.db');
    let db = openDb(path);
    db.prepare("INSERT INTO players (steamid, name) VALUES ('76561199000000001', 'me')").run();
    db.prepare("INSERT INTO servers (name, host, port, rcon_port, rcon_password) VALUES ('a', 'h', 27015, 27015, 'x')").run();
    // Put the table back the way production has it today.
    db.exec(`DROP TABLE practice_leases;
      CREATE TABLE practice_leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER NOT NULL REFERENCES servers(id),
        kind TEXT NOT NULL CHECK (kind IN ('park','drill')), owner_player_id TEXT NOT NULL REFERENCES players(steamid),
        password TEXT NOT NULL, drill_code TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), ready_at TEXT,
        last_human_at TEXT NOT NULL DEFAULT (datetime('now')), ends_at TEXT NOT NULL, humans INTEGER NOT NULL DEFAULT 0,
        map TEXT, warned_at TEXT, ending_at TEXT, ended_at TEXT, end_reason TEXT, setup_phase TEXT);
      INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at, humans)
        VALUES (1, 'park', '76561199000000001', 'pw1', 'e1', 3), (1, 'drill', '76561199000000001', 'pw2', 'e2', 0);`);
    db.close();
    db = openDb(path);
    const rows = db.prepare('SELECT id, kind, password, humans FROM practice_leases ORDER BY id').all();
    expect(rows).toEqual([
      { id: 1, kind: 'park', password: 'pw1', humans: 3 },
      { id: 2, kind: 'drill', password: 'pw2', humans: 0 },
    ]);
    db.prepare(`INSERT INTO practice_leases (server_id, kind, owner_player_id, password, ends_at)
      VALUES (1, 'hunter', '76561199000000001', 'x', 'x')`).run();
    // The partial index for open leases came back with the rebuilt table.
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'practice_leases' ORDER BY name").all();
    expect(idx).toEqual([{ name: 'practice_leases_open' }, { name: 'practice_leases_owner' }]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('custom campaigns default to not practice-only', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(custom_campaigns)').all() as { name: string; dflt_value: string }[];
    expect(cols.find((c) => c.name === 'practice_only')?.dflt_value).toBe('0');
  });
});
```

Check the `servers` and `players` INSERT column names against the SCHEMA at the top of `src/db.ts` before running; use `addServer` / `upsertPlayer` from `src/serverPool.ts` / `src/players.ts` instead if a NOT NULL column is missing.

- [ ] **Step 2: Run them to see them fail**

Run: `cd /home/volence/l4d/pug && npx vitest run tests/db.test.ts -t "practice_leases kinds"`
Expected: the hunter inserts fail with `CHECK constraint failed`, the practice_only test fails on `undefined`.

- [ ] **Step 3: Implement**

In `src/db.ts`, change the table's line to:

```ts
      kind            TEXT NOT NULL CHECK (kind IN ('park','drill','hunter')),
```

Right after the existing `ensureColumn(db, 'practice_leases', 'setup_phase', 'TEXT');` add:

```ts
  // 'hunter' joined 'park' and 'drill' on 2026-09-28 (Hunter Training). CREATE
  // TABLE IF NOT EXISTS leaves an older table's CHECK as it was, so a table
  // without it is rebuilt once.
  widenCheck(db, 'practice_leases', "'hunter'", [
    'CREATE INDEX IF NOT EXISTS practice_leases_open ON practice_leases (server_id) WHERE ended_at IS NULL',
    'CREATE INDEX IF NOT EXISTS practice_leases_owner ON practice_leases (owner_player_id, created_at)',
  ]);
  // Practice-only campaigns (Hunter Training) install everywhere and are
  // downloadable, but are never offered for the PUG map pool.
  ensureColumn(db, 'custom_campaigns', 'practice_only', 'INTEGER NOT NULL DEFAULT 0');
```

Next to `ensureColumn`, add:

```ts
/**
 * Rebuild `table` from the CREATE statement in SCHEMA / openDb when its stored
 * definition lacks `marker` (a value a widened CHECK now allows). SQLite cannot
 * alter a CHECK, so this is its standard procedure: a new table from the current
 * definition, copy the shared columns, drop the old, rename, then the indexes
 * (they go with the dropped table). Foreign keys are off for the swap and back
 * on after; nothing may reference `table`, which the caller checks.
 */
function widenCheck(db: DB, table: string, marker: string, indexes: string[]): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (!row || row.sql.includes(marker)) return;
  const current = CURRENT_DDL[table];
  if (!current) throw new Error(`widenCheck: no current definition for ${table}`);
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(current.replace(`CREATE TABLE IF NOT EXISTS ${table} (`, `CREATE TABLE ${table}_new (`));
      const oldCols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      const newCols = new Set((db.prepare(`PRAGMA table_info(${table}_new)`).all() as { name: string }[]).map((c) => c.name));
      const cols = oldCols.filter((c) => newCols.has(c)).join(', ');
      db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      for (const sql of indexes) db.exec(sql);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
```

and move the practice_leases `CREATE TABLE IF NOT EXISTS practice_leases (...)` text into a module constant so both the create and the rebuild use one definition:

```ts
/** Table definitions widenCheck may rebuild from. One copy, used by openDb too. */
const CURRENT_DDL: Record<string, string> = {
  practice_leases: `CREATE TABLE IF NOT EXISTS practice_leases (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id       INTEGER NOT NULL REFERENCES servers(id),
      kind            TEXT NOT NULL CHECK (kind IN ('park','drill','hunter')),
      owner_player_id TEXT NOT NULL REFERENCES players(steamid),
      password        TEXT NOT NULL,
      drill_code      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      ready_at        TEXT,
      setup_phase     TEXT,
      last_human_at   TEXT NOT NULL DEFAULT (datetime('now')),
      ends_at         TEXT NOT NULL,
      humans          INTEGER NOT NULL DEFAULT 0,
      map             TEXT,
      warned_at       TEXT,
      ending_at       TEXT,
      ended_at        TEXT,
      end_reason      TEXT
    )`,
};
```

In openDb, the existing `db.exec(\`CREATE TABLE IF NOT EXISTS practice_leases (...); CREATE INDEX ...\`)` becomes `db.exec(CURRENT_DDL.practice_leases); db.exec('CREATE INDEX IF NOT EXISTS practice_leases_open ...'); db.exec('CREATE INDEX IF NOT EXISTS practice_leases_owner ...');` with the comment block above it kept as it is.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/db.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git checkout -b hunter-training   # first task on the branch; check git status / reflog first
git add src/db.ts tests/db.test.ts
git commit -m "db: practice_leases takes kind hunter (one-time CHECK rebuild); custom_campaigns.practice_only"
```

---

### Task 6: Lease manager: the hunter kind

A hunter lease is owned and private like a drill server: one open owned server (drill or hunter) per player, only its owner plays, idle end 5 minutes (a single-player box the queue could have). Its cfg check reads `l4d_ht_enable` instead of `l4d_practice_mode`, since `l4d_practice` is not loaded on it.

**Files:**
- Modify: `/home/volence/l4d/pug/src/practiceLeases.ts`
- Test: `/home/volence/l4d/pug/tests/practiceLeases.test.ts`

**Interfaces:**
- Produces:
  - `export type LeaseKind = 'park' | 'drill' | 'hunter';`
  - `export const OWNED_KINDS: readonly LeaseKind[] = ['drill', 'hunter'];`
  - `export function openOwnedLeaseOf(db: DB, steamid: string): LeaseRow | undefined` (replaces `openDrillLeaseOf`; update every caller: `src/routes/practice.ts` twice, `src/practiceLeases.ts` in `create`).
  - `export interface HunterListing { id: number; server: string; ready: boolean; inUse: boolean; endsAt: string }` and `export function hunterListings(db: DB): HunterListing[]`.
  - `export const HUNTER_CAPACITY = 1;`
  - `export const MODE_CHECK: Record<LeaseKind, { cvar: string; value: string }>`.

- [ ] **Step 1: Teach the fake box the hunter cfg**

In `tests/practiceLeases.test.ts`, extend the fake `rcon` in `manager()`:
- the reads filter: `cmds.every((c) => c === 'l4d_game_type_name' || c === 'l4d_practice_mode' || c === 'l4d_ht_enable')`
- answer `l4d_ht_enable`: `if (c === 'l4d_ht_enable') return \`"l4d_ht_enable" = "${b.mode === 'hunter' ? '1' : '0'}"\`;`
- the exec regex: `/^exec practice_(park|drill|hunter)\.cfg$/`, and the type: `b.type = m[1] === 'park' ? 'Practice (drills)' : m[1] === 'hunter' ? 'Hunter Training' : 'Rotoblin 4v4 PUG';`

- [ ] **Step 2: Write the failing tests**

Add to the `import` from `../src/practiceLeases.js`: `HUNTER_CAPACITY, hunterListings, openOwnedLeaseOf`. Add:

```ts
describe('hunter leases', () => {
  it('execs the hunter cfg, checks l4d_ht_enable, and sends the ht password and owner twice', async () => {
    seedServer('a'); seedServer('bb');
    mgr = manager();
    const r = await mgr.create(ME, 'hunter');
    expect(r.ok && !r.joined).toBe(true);
    if (!r.ok) return;
    await flush();
    const pw = getLease(db, r.lease.id)!.password;
    const id = [`sm_cvar sv_password "${pw}"`, `l4d_ht_password "${pw}"`, `l4d_ht_owner ${ME}`];
    expect(sent.map((s) => s.cmds)).toEqual([['status'], ['(restart)'], ['exec practice_hunter.cfg'], id, id, ['status']]);
    expect(reads).toContain('l4d_ht_enable');
    expect(reads).not.toContain('l4d_practice_mode');
    expect(getLease(db, r.lease.id)!.ready_at).not.toBeNull();
  });

  it('one owned server per player: a drill blocks a hunter server and the other way round', async () => {
    seedServer('a'); seedServer('bb'); seedServer('ccc'); seedServer('dddd');
    mgr = manager();
    const d = await mgr.create(ME, 'drill');
    expect(await mgr.create(ME, 'hunter')).toMatchObject({ ok: false, status: 409, leaseId: d.ok ? d.lease.id : -1 });
    const h = await mgr.create(YOU, 'hunter');
    expect(openOwnedLeaseOf(db, YOU)?.id).toBe(h.ok ? h.lease.id : -1);
    expect(await mgr.create(YOU, 'drill')).toMatchObject({ ok: false, status: 409 });
  });

  it('never hands back someone else\'s hunter server the way a park is shared', async () => {
    seedServer('a'); seedServer('bb'); seedServer('ccc');
    mgr = manager();
    const mine = await mgr.create(ME, 'hunter');
    const yours = await mgr.create(YOU, 'hunter');
    expect(yours.ok && !yours.joined).toBe(true);
    expect(yours.ok && mine.ok && yours.lease.id !== mine.lease.id).toBe(true);
  });

  it('ends an empty hunter server after five minutes', () => {
    expect(IDLE_END_MS.hunter).toBe(5 * 60_000);
  });

  it('lists hunter servers as in use from the first human, never with a password', async () => {
    seedServer('a'); seedServer('bb');
    mgr = manager();
    const r = await mgr.create(ME, 'hunter');
    await flush();
    expect(hunterListings(db)).toEqual([
      expect.objectContaining({ id: r.ok ? r.lease.id : -1, server: 'bb', ready: true, inUse: false }),
    ]);
    db.prepare('UPDATE practice_leases SET humans = ?').run(HUNTER_CAPACITY);
    expect(hunterListings(db)[0].inUse).toBe(true);
    expect(JSON.stringify(hunterListings(db))).not.toContain(getLease(db, r.ok ? r.lease.id : -1)!.password);
  });

  it('the invite page gives the connect line to the owner and admins only', async () => {
    seedServer('a'); seedServer('bb');
    mgr = manager();
    const r = await mgr.create(ME, 'hunter');
    if (!r.ok) throw new Error('no lease');
    const lease = getLease(db, r.lease.id)!;
    expect(leaseView(db, lease, ME, false).connect).not.toBeNull();
    expect(leaseView(db, lease, YOU, true).connect).not.toBeNull();
    expect(leaseView(db, lease, YOU, false).connect).toBeNull();
    expect(leaseView(db, lease, YOU, false).capacity).toBe(HUNTER_CAPACITY);
  });
});
```

Also update the existing test `'one open drill server per player'` only if its message assertion names "drill server" (it asserts status and leaseId only, so it should pass unchanged).

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/practiceLeases.test.ts -t "hunter leases"`
Expected: type errors / failures on `'hunter'`, `openOwnedLeaseOf`, `hunterListings`.

- [ ] **Step 4: Implement**

In `src/practiceLeases.ts`:

1. The header comment's "Two kinds" becomes "Three kinds" with a third entry:

```ts
 *   hunter A private server running Hunter Training (eyeonus's map, cheats
 *          off; l4d/practice/l4d_hunter_training.sp). One player: the map
 *          moves one shared set of target bots, so two hunters would break
 *          each other's rooms. Owned like a drill server, and a player has
 *          one owned server (drill or hunter) at a time.
```

2. Types and constants:

```ts
export type LeaseKind = 'park' | 'drill' | 'hunter';
/** Kinds a player owns: private, one open at a time per player. */
export const OWNED_KINDS: readonly LeaseKind[] = ['drill', 'hunter'];
/** Humans a Hunter Training server takes: its owner. */
export const HUNTER_CAPACITY = 1;
```

`IDLE_END_MS` gains `hunter: 5 * 60_000` (comment: a one-player box, given back as soon as the park is). `GAME_TYPE_MARK` gains `hunter: 'Hunter Training'`. Add:

```ts
/** The cvar that says which practice plugin mode a box is in, and the value
 *  each kind must read. park and drill share l4d_practice's mode cvar; the
 *  hunter box runs l4d_hunter_training instead, which has its own switch. */
export const MODE_CHECK: Record<LeaseKind, { cvar: string; value: string }> = {
  park: { cvar: 'l4d_practice_mode', value: 'park' },
  drill: { cvar: 'l4d_practice_mode', value: 'drill' },
  hunter: { cvar: 'l4d_ht_enable', value: '1' },
};
```

3. `openDrillLeaseOf` becomes:

```ts
/** The player's open owned server (drill or hunter), if any. One at a time
 *  per player. Parks are ownerless (owner, 2026-09-28): starting one is not
 *  "having a server", so a park never counts here and never blocks one. */
export function openOwnedLeaseOf(db: DB, steamid: string): LeaseRow | undefined {
  return db.prepare(
    `SELECT * FROM practice_leases WHERE owner_player_id = ? AND kind IN (${OWNED_KINDS.map(() => '?').join(',')})
       AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
  ).get(steamid, ...OWNED_KINDS) as LeaseRow | undefined;
}
```

In `create`: `const mine = OWNED_KINDS.includes(kind) ? openOwnedLeaseOf(this.db, owner) : undefined;` and the 409 message: `` `You already have a ${mine.kind === 'drill' ? 'drill' : 'Hunter Training'} server open. Close it before starting another.` ``

4. `identityLines`:

```ts
export function identityLines(lease: Pick<LeaseRow, 'kind' | 'password' | 'owner_player_id'>, publicUrl: string): string[] {
  if (!/^[a-z0-9]+$/.test(lease.password)) throw new Error('lease password has unexpected characters');
  if (OWNED_KINDS.includes(lease.kind) && !/^\d{17}$/.test(lease.owner_player_id)) throw new Error('lease owner is not a SteamID64');
  if (lease.kind === 'hunter') {
    // l4d_hunter_training's own cvars: l4d_practice is not loaded on this box.
    return [
      `sm_cvar sv_password ${quoted(lease.password)}`,
      `l4d_ht_password ${quoted(lease.password)}`,
      `l4d_ht_owner ${lease.owner_player_id}`,
    ];
  }
  ... the existing return, unchanged ...
}
```

Keep the existing `publicUrl` quoting check where it is (the hunter branch does not use the URL; place the branch after that check so a bad URL still throws for every kind).

5. `configHolds`:

```ts
  private async configHolds(server: ServerRow, kind: LeaseKind): Promise<{ ok: boolean; seen: string }> {
    const mode = MODE_CHECK[kind];
    try {
      const [type, modeReply] = await this.deps.rcon(server, ['l4d_game_type_name', mode.cvar]);
      const t = cvarValue(type, 'l4d_game_type_name') ?? '';
      const m = cvarValue(modeReply, mode.cvar) ?? '';
      return { ok: t.includes(GAME_TYPE_MARK[kind]) && m === mode.value, seen: `game type "${t}", ${mode.cvar} "${m}"` };
    } catch (err) {
      return { ok: false, seen: `no answer (${err instanceof Error ? err.message : String(err)})` };
    }
  }
```

6. `leaseView`: `isOwner` becomes `OWNED_KINDS.includes(l.kind) && viewer === l.owner_player_id`; `capacity` becomes `l.kind === 'park' ? PARK_CAPACITY : l.kind === 'hunter' ? HUNTER_CAPACITY : null`; `connect` gains `&& (l.kind !== 'hunter' || isOwner || viewerIsAdmin)` with the comment `// A hunter server is one player's: the invite link is not a way in for others.`

7. Listings, after `parkListings`:

```ts
/** One Hunter Training server on the public list. No password, no host. */
export interface HunterListing {
  id: number;
  server: string;
  ready: boolean;
  /** Its one player is on. */
  inUse: boolean;
  endsAt: string;
}

export function hunterListings(db: DB): HunterListing[] {
  return (db.prepare(
    "SELECT * FROM practice_leases WHERE kind = 'hunter' AND ended_at IS NULL AND end_reason IS NULL ORDER BY id",
  ).all() as LeaseRow[]).map((l) => ({
    id: l.id,
    server: getServer(db, l.server_id)?.name ?? `server ${l.server_id}`,
    ready: l.ready_at !== null,
    inUse: l.humans >= HUNTER_CAPACITY,
    endsAt: l.ends_at,
  }));
}
```

Also grep the file for other `'drill'` / `'park'` literals (`rg -n "'drill'|'park'" src/practiceLeases.ts`) and decide each: the drill_code preload stays drill-only; the `kind !== 'drill'` refusal in the drill-load path stays; nothing else should need `hunter`.

- [ ] **Step 5: Run the whole file and the type check**

Run: `npx vitest run tests/practiceLeases.test.ts && npx tsc --noEmit`
Expected: PASS. Fix `openDrillLeaseOf` callers that tsc names.

- [ ] **Step 6: Commit**

```bash
git add src/practiceLeases.ts tests/practiceLeases.test.ts src/routes/practice.ts
git commit -m "practice leases: kind hunter (owned, one player, l4d_ht_enable check, ht identity lines, public listing)"
```

---

### Task 7: Routes, the practice-only flag, and the download credit

**Files:**
- Modify: `/home/volence/l4d/pug/src/routes/practice.ts` (`POST /api/practice/leases` near line 191, `GET /api/practice/park` near line 221)
- Modify: `/home/volence/l4d/pug/src/customCampaigns.ts` (`CustomCampaignRow`, new `setPracticeOnly`)
- Modify: `/home/volence/l4d/pug/src/campaignRegistry.ts` (`poolableCampaigns` near line 177)
- Modify: `/home/volence/l4d/pug/src/routes/campaigns.ts` (`GET /api/campaigns/custom` near line 90, new admin route)
- Test: `/home/volence/l4d/pug/tests/practiceRoutes.test.ts`, `/home/volence/l4d/pug/tests/campaignRegistry.test.ts`, `/home/volence/l4d/pug/tests/campaignRoutes.test.ts`

**Interfaces:**
- Consumes: `hunterListings`, `openOwnedLeaseOf` (Task 6).
- Produces: `GET /api/practice/park` answers `{ available, parks, hunters: HunterListing[], mine: { id, kind } | null }`; `POST /api/practice/leases` accepts `kind: 'hunter'`; `GET /api/campaigns/custom` items gain `practiceOnly: boolean`; `POST /api/admin/campaigns/:slug/practice-only` with body `{ practiceOnly: boolean }`.

- [ ] **Step 1: Write the failing tests**

In `tests/practiceRoutes.test.ts`, follow the file's existing app/session helpers (read its first 80 lines for how a logged-in request and a fake lease manager are built) and add:

```ts
it('starts a hunter server', async () => {
  // Same setup as the existing "starts a park" test in this file, with kind 'hunter'.
  const res = await app.inject({ method: 'POST', url: '/api/practice/leases', payload: { kind: 'hunter' }, headers: authed(ME) });
  expect(res.statusCode).toBe(200);
  expect(res.json().lease.kind).toBe('hunter');
});

it('refuses a drill code on a hunter server', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/practice/leases', payload: { kind: 'hunter', drillCode: 'K7QX' }, headers: authed(ME) });
  expect(res.statusCode).toBe(400);
});

it('lists hunter servers next to parks', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/practice/park' });
  expect(res.json()).toHaveProperty('hunters');
});
```

Replace `authed(ME)` and the manager setup with whatever this file already uses; if it only tests park, copy that test and change the kind.

In `tests/campaignRegistry.test.ts`, next to the existing poolableCampaigns tests (they already seed a published, installed custom campaign; reuse that seeding):

```ts
it('never offers a practice-only campaign for the pool, even if already in it', () => {
  // seed: published custom campaign 'hunter_training' installed on every enabled server
  db.prepare("UPDATE custom_campaigns SET practice_only = 1 WHERE slug = 'hunter_training'").run();
  invalidateCampaignCache();
  expect(poolableCampaigns(db).map((c) => c.slug)).not.toContain('hunter_training');
  expect(poolableCampaigns(db, { alsoAllow: ['hunter_training'] }).map((c) => c.slug)).not.toContain('hunter_training');
});
```

In `tests/campaignRoutes.test.ts`:

```ts
it('reports practiceOnly on the public list, and an admin can set it', async () => {
  // seed a published campaign 'hunter_training' as the file's other tests do
  let list = (await app.inject({ method: 'GET', url: '/api/campaigns/custom' })).json();
  expect(list.campaigns.find((c: { slug: string }) => c.slug === 'hunter_training').practiceOnly).toBe(false);
  const res = await app.inject({ method: 'POST', url: '/api/admin/campaigns/hunter_training/practice-only',
    payload: { practiceOnly: true }, headers: adminHeaders });
  expect(res.statusCode).toBe(200);
  list = (await app.inject({ method: 'GET', url: '/api/campaigns/custom' })).json();
  expect(list.campaigns.find((c: { slug: string }) => c.slug === 'hunter_training').practiceOnly).toBe(true);
  expect((await app.inject({ method: 'POST', url: '/api/admin/campaigns/nope/practice-only',
    payload: { practiceOnly: true }, headers: adminHeaders })).statusCode).toBe(404);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/practiceRoutes.test.ts tests/campaignRegistry.test.ts tests/campaignRoutes.test.ts`
Expected: the new tests fail (400 for hunter, missing `hunters`, practice-only still poolable, 404 route).

- [ ] **Step 3: Implement**

`src/routes/practice.ts`:
- `if (kind !== 'park' && kind !== 'drill' && kind !== 'hunter') return reply.code(400).send({ error: 'kind must be park, drill or hunter' });`
- the park route: import `hunterListings`, `openOwnedLeaseOf`; `const mine = viewer ? openOwnedLeaseOf(db, viewer) : undefined;`; the unavailable answer gains `hunters: []`; the available answer gains `hunters: hunterListings(db)`. Update the route's doc comment: "which parks and Hunter Training servers are open".

`src/customCampaigns.ts`: `CustomCampaignRow` gains `/** 1: installs and downloads, never offered for the PUG pool. */ practice_only: number;` and:

```ts
export function setPracticeOnly(db: DB, slug: string, practiceOnly: boolean): boolean {
  return db.prepare('UPDATE custom_campaigns SET practice_only = ? WHERE slug = ?').run(practiceOnly ? 1 : 0, slug).changes > 0;
}
```

`src/campaignRegistry.ts`: `CampaignEntry` gains `practiceOnly: boolean` (false for stock entries, `row.practice_only === 1` for custom ones in `build`). In `poolableCampaigns`, first line of the filter callback: `if (c.practiceOnly) return false;` with the comment `// Before alsoAllow: a practice map is never a PUG map, whatever the saved pool says.`

`src/routes/campaigns.ts`: the public list item gains `practiceOnly: c.practice_only === 1`. New route after `maps-to-play`:

```ts
  app.post('/api/admin/campaigns/:slug/practice-only', async (req, reply) => {
    const adminId = requireAdmin(req, reply);
    if (!adminId) return reply;
    const { slug } = req.params as { slug: string };
    const raw = (req.body as { practiceOnly?: unknown } | undefined)?.practiceOnly;
    if (typeof raw !== 'boolean') return reply.code(400).send({ error: 'practiceOnly must be true or false' });
    if (!setPracticeOnly(db, slug, raw)) return reply.code(404).send({ error: 'no such campaign' });
    invalidateCampaignCache();
    logAdmin(db, adminId, 'campaign_practice_only', slug, { practiceOnly: raw });
    return { ok: true };
  });
```

If `map_pool` validation (`validateSetting`) already goes through `poolableCampaigns`, a PUT of a pool containing a practice-only slug is refused with no further change; confirm with `rg -n "poolableCampaigns" src` and add a test in `tests/settings*.test.ts` if it does not.

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/practice.ts src/customCampaigns.ts src/campaignRegistry.ts src/routes/campaigns.ts tests/
git commit -m "practice: hunter kind on the routes; custom campaigns can be practice-only (never poolable)"
```

---

### Task 8: Web: the Play card, the invite page, downloads and admin toggle

**Files:**
- Modify: `/home/volence/l4d/pug/web/src/api.ts` (near lines 1788 to 1882)
- Modify: `/home/volence/l4d/pug/web/src/practice.ts`
- Modify: `/home/volence/l4d/pug/web/src/components/PracticeCard.tsx`
- Modify: `/home/volence/l4d/pug/web/src/routes/Practice.tsx`
- Modify: `/home/volence/l4d/pug/web/src/routes/CustomCampaigns.tsx`, `/home/volence/l4d/pug/web/src/routes/admin/AdminCampaigns.tsx`
- Test: `/home/volence/l4d/pug/web/src/components/PracticeCard.test.tsx`

**Interfaces:**
- Consumes: the API shapes from Task 7.
- Produces: `PracticeKind = 'park' | 'drill' | 'hunter'`; `PracticeHunterListing`; `PracticeParks.hunters`; `KIND_LABEL.hunter = 'Hunter Training'`; `IDLE_MINUTES.hunter = 5`; `HUNTER_DOWNLOAD = '/download/campaign/hunter_training'`.

- [ ] **Step 1: Write the failing card tests**

In `PracticeCard.test.tsx`, change `parks()` to include `hunters: []` by default, and add:

```tsx
const HUNT = { id: 7, server: 'Riverside #6', ready: true, inUse: true, endsAt: '2026-09-28T14:00:00Z' };

it('offers both starts when nothing is open', async () => {
  mockApi.practiceParks.mockResolvedValue(parks({ parks: [], hunters: [] }));
  render(<PracticeCard signedIn />);
  expect(await screen.findByRole('button', { name: 'Start a Practice Park' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Start Hunter Training' }));
  expect(mockApi.startPractice).toHaveBeenCalledWith({ kind: 'hunter' });
});

it('with a park open: Join the park, and still Start Hunter Training', async () => {
  mockApi.practiceParks.mockResolvedValue(parks());
  render(<PracticeCard signedIn />);
  expect((await screen.findByRole('link', { name: 'Join' })).getAttribute('href')).toBe('/practice/3');
  expect(screen.getByRole('button', { name: 'Start Hunter Training' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start a Practice Park' })).toBeNull();
});

it('lists a Hunter Training server as in use, with no Join, and still offers your own', async () => {
  mockApi.practiceParks.mockResolvedValue(parks({ hunters: [HUNT] }));
  render(<PracticeCard signedIn />);
  expect(await screen.findByText('Riverside #6')).toBeTruthy();
  expect(screen.getByText('in use')).toBeTruthy();
  expect(screen.getAllByRole('link', { name: 'Join' })).toHaveLength(1); // the park's only
  expect(screen.getByRole('button', { name: 'Start Hunter Training' })).toBeTruthy();
});

it('says the map is a download, with the link', async () => {
  mockApi.practiceParks.mockResolvedValue(parks({ parks: [], hunters: [] }));
  render(<PracticeCard signedIn />);
  const link = await screen.findByRole('link', { name: 'Get the Hunter Training map' });
  expect(link.getAttribute('href')).toBe('/download/campaign/hunter_training');
});

it('links back to your own Hunter Training server', async () => {
  mockApi.practiceParks.mockResolvedValue(parks({ mine: { id: 7, kind: 'hunter' } }));
  render(<PracticeCard signedIn />);
  expect((await screen.findByRole('link', { name: 'Your hunter training' })).getAttribute('href')).toBe('/practice/7');
});
```

Keep the existing test `'lists the open park ... '` but its last assertion (no 'Start a Practice Park' with a park open) still holds.

- [ ] **Step 2: Run them to see them fail**

Run: `cd /home/volence/l4d/pug && npx vitest run web/src/components/PracticeCard.test.tsx`
Expected: the new tests fail.

- [ ] **Step 3: Implement**

`web/src/api.ts`: `export type PracticeKind = 'park' | 'drill' | 'hunter';`, add

```ts
export interface PracticeHunterListing {
  id: number; server: string; ready: boolean; inUse: boolean; endsAt: string;
}
```

and `hunters: PracticeHunterListing[];` in `PracticeParks` (comment: `/** Open Hunter Training servers: one player each, so no Join. */`). Update the "Kept field for field" comment to name HunterListing.

`web/src/practice.ts`: `IDLE_MINUTES` gains `hunter: 5`; `KIND_LABEL` gains `hunter: 'Hunter Training'`; `setupText`'s `what` becomes `lease.kind === 'park' ? 'the Practice Park' : lease.kind === 'hunter' ? 'your Hunter Training server' : 'your drill server'`; add

```ts
/** The Hunter Training map's download (a published, practice-only custom campaign). */
export const HUNTER_DOWNLOAD = '/download/campaign/hunter_training';
```

`web/src/components/PracticeCard.tsx`:
- `start` takes the kind: `const start = async (kind: 'park' | 'hunter') => { ... api.startPractice({ kind }) ... setError(... kind === 'park' ? 'Could not start the Practice Park.' : 'Could not start Hunter Training.') }`
- Blurb becomes: "Skeets, pounces, rocks and crowns on a real server with the PUG settings, or the Hunter Training course on your own server. Unranked, open to every player."
- After the parks list, render the hunter list with the same row markup: server name, then `<span class="muted practice-card__map">{h.ready ? (h.inUse ? 'in use' : 'waiting for its player') : 'starting up'}</span>`, no Join, prefixed by a `<span class="practice-card__kind">Hunter Training</span>`. Give park rows the same `practice-card__kind` label reading "Practice Park" so the two lists read alike.
- Signed-in buttons, in a `div class="practice-card__starts"`:
  - `data.parks.length === 0` → `Start a Practice Park` (as now, now calling `start('park')`).
  - always → `<button class="btn btn--block btn--ghost" ...>Start Hunter Training</button>` calling `start('hunter')`; busy text 'Starting...'.
- Under the buttons: `<p class="muted practice-card__need">Hunter Training needs its map (222 MB). <a href={HUNTER_DOWNLOAD}>Get the Hunter Training map</a>, then restart Left 4 Dead before joining.</p>`. The link text is exactly "Get the Hunter Training map" (the test finds it by name).
- `data.mine` link text already uses `KIND_LABEL[...]`, so "Your hunter training" comes for free.
- Add CSS for `.practice-card__starts` (flex, gap 8px, wraps under 360px) and `.practice-card__kind` next to the existing `.practice-card__*` rules (`rg -n "practice-card__" web/src` finds the stylesheet).

`web/src/routes/Practice.tsx` (the invite page):
- For `lease.kind === 'hunter' && open`, show above the connect block: "Hunter Training runs on eyeonus's map. If you have not installed it: <a href={HUNTER_DOWNLOAD}>download it</a>, put the .vpk in left4dead/addons, and restart Left 4 Dead." and under it "This server is yours alone; anyone else who joins watches from spectator."
- `connect === null` on a hunter lease for a non-owner: show "This Hunter Training server belongs to {lease.owner.name}. Start your own from the Play page." in place of the connect block.
- `mapLabel`: `lease.kind === 'hunter'` while loading shows `Hunter Training (loading)`.

`web/src/routes/CustomCampaigns.tsx` (downloads): where `c.inPool && <span class="ccamp__pool">In the vote</span>` is, add `{c.practiceOnly && <span class="ccamp__pool">Practice map</span>}`, and add `practiceOnly: boolean` to the item type in `api.ts`.

`web/src/routes/admin/AdminCampaigns.tsx`: a checkbox "Practice only (never in the PUG pool)" per published custom campaign, calling a new `api.setCampaignPracticeOnly(slug, practiceOnly)` (`post('/api/admin/campaigns/' + encodeURIComponent(slug) + '/practice-only', { practiceOnly })`), reloading the list after.

- [ ] **Step 4: Run the web tests, the whole suite, and a build**

Run: `npx vitest run web/src && npm test && npx tsc --noEmit && npm run build`
Expected: PASS and a clean build. Then `npm run shoot` (the site's screenshot script, see memory pug-site-redesign) for the Play page at desktop and 390 px width, and look at both screenshots: two start buttons side by side on desktop, stacked on the phone, no horizontal scroll.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "web: Hunter Training on the Play card (start, in-use rows, map download), invite page, practice-only badge and admin toggle"
```

---

### Task 9: Ship (owner go-ahead required)

Nothing in this task runs until the owner says so, and every live step follows the deploy rules in memory ([[feedback-deploy-when-empty]], [[l4d1-stage-on-restart]], [[pug-deploy-verification]]).

- [ ] **Step 1: Game files into the deploy repo**

Copy into `/home/volence/l4d/deploy/overrides/left4dead/`: `addons/sourcemod/plugins/optional/l4d_hunter_training.smx`, `cfg/practice_hunter.cfg`, `cfg/practice_hunter_map.cfg`, `addons/stripper/Roto-AZMod/maps/hunter_training_map.cfg`. Commit: `Hunter Training: plugin, lease cfgs, stripper rewrite (inert until a hunter lease execs practice_hunter.cfg)`. These are inert on a PUG box: nothing execs `practice_hunter.cfg` except a hunter lease, and the stripper file only applies on `hunter_training_map`. Stage them to all enabled servers with `deploy/tools/stage-on-restart.sh` so they land between matches.

- [ ] **Step 2: Upload the map as a custom campaign**

Rename `hunter_training[1].vpk` to `hunter_training.vpk` (brackets break URLs and shell globs). Upload through the admin Campaigns page. Confirm the chapter list shows the two versus maps; untick `hunter_training_c21` (phase 1). Publish. Set notes to `Map by eyeonus (gamemaps.com/details/5549). Practice only.` (the downloads page already shows notes: this is the author credit). Tick "Practice only". Check `custom_campaign_installs` shows `installed` for every enabled server; any `failed` row is the Riverside transport gap in memory [[l4d1-custom-campaign-pooling]] and is fixed by copying the VPK by hand plus the install row, as done for City 17. The VPK mounts on the next srcds restart, which every lease setup does.

- [ ] **Step 3: Web deploy**

Merge `hunter-training` into master (check reflog and status first: other sessions commit there), run `deploy-web.sh`, and verify with the recipe in [[pug-deploy-verification]] (tree hash, bundle contains "Start Hunter Training", `practice_leases` CHECK now lists hunter: `sqlite3 /home/pug/pug.db ".schema practice_leases"`). Back up the DB first: `cp /home/pug/pug.db /home/pug/pug.db.pre-hunter-$(date +%Y%m%d)`.

- [ ] **Step 4: First real lease**

Owner starts Hunter Training from the Play page, plays rooms 1 to 3 and the finish, ends it. Check the admin feed for no setup problem, `sv_cheats 0` during the lease, and that the box restarted back to Pub VS after.

- [ ] **Step 5: Memory**

Update `l4d1-hunter-training-map` and `l4d1-practice-drills` with what shipped, the commit hashes, and anything left (Live Fire Course, credits for the other custom maps).

---

## Later, not in this plan

- **Live Fire Course** (`hunter_training_c21`): bots shoot a 6000 HP hunter; its class rooms use `z_spawn` for L4D2 classes (spitter, jockey, charger) that do not exist on L4D1. Needs its own stripper rules and an in-game look first.
- **Author credits for every custom map**: the owner noted none of the other downloads credit their authors (2026-09-28). The `notes` field already renders on the downloads page, so this is data entry.
