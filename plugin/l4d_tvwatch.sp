/**
 * l4d_tvwatch - put SourceTV spectator activity on the PUG wire.
 *
 * The SourceTV Manager extension (sourcetvmanager.ext) exposes the local
 * HLTV/SourceTV proxy's connect and disconnect events. This bridges them onto
 * the logaddress stream the site already listens to (src/logParse.ts, the
 * PUGTV branch), signed through PugLog the same as PUGNET and the site's
 * other marker-anchored lines:
 *
 *   PUGTV event=join slot=3 ip=203.0.113.7 cc=US name=some name here
 *   PUGTV event=leave slot=3 reason=Disconnect by user. name=some name here
 *   PUGTV event=start
 *   PUGTV event=stop
 *
 * `cc=` is omitted when GeoIP is unavailable or the lookup misses, exactly
 * like EmitClientNet's PUGNET line in pug-match.sp. `name=` is always last on
 * the line, since spaces in a name are fine there but nowhere else.
 *
 * SourceTV Manager and GeoIP are both optional. <sourcemod> (via core.inc)
 * `#define REQUIRE_EXTENSIONS` unconditionally, so both includes are wrapped
 * in `#undef REQUIRE_EXTENSIONS` / `#include` / `#define REQUIRE_EXTENSIONS`,
 * the same pattern pug-match.sp uses around its own `#include <geoip>`.
 * Without that undef/define pair each include's Extension block would come
 * out `required = 1` and SourceMod would refuse to load this plugin at all
 * on a box missing either extension ("Required extension ... not running"),
 * rather than loading it inert. With the pair, both Extension blocks come
 * out `required = 0` and every native either exposes gets marked optional
 * (see each include's own __ext_..._SetNTVOptional). A server missing
 * SourceTV Manager loads this plugin cleanly; the SourceTV_On* forwards are
 * simply never invoked (nothing calls into a plugin's forward implementation
 * but the extension itself), so nothing here ever touches an unbound
 * native. A server missing GeoIP also loads cleanly; GeoipCode2 is
 * feature-checked before every call (see SourceTV_OnSpectatorConnected), so
 * `cc=` is simply omitted.
 *
 * Disconnect timing: SourceTV_OnSpectatorDisconnected fires AFTER the client
 * is gone. SourceTV Manager's natives (GetClientName, GetClientIP,
 * IsClientProxy, ...) all reject a client that IsConnected() no longer
 * reports true, so calling any of them from this forward throws. The name
 * and the proxy flag are therefore cached per slot at connect time
 * (SourceTV_OnSpectatorConnected, where the client is still live) and only
 * the cache is read at disconnect.
 *
 * Build: ./build-tvwatch.sh, which mirrors build.sh (copies sources and
 * includes into the Rotoblin scripting tree, compiles with the vendored
 * spcomp under wine, copies l4d_tvwatch.smx back out).
 */
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
// Both optional: neither extension is guaranteed to be running on every box.
// core.inc (pulled in by <sourcemod>) already #defined REQUIRE_EXTENSIONS by
// this point, so it must be undef'd here or both Extension blocks below
// would come out required = 1 and SourceMod would refuse to load this
// plugin at all wherever either extension is absent.
#undef REQUIRE_EXTENSIONS
#include <sourcetvmanager>
#include <geoip>
#define REQUIRE_EXTENSIONS
#include "pug-logauth.inc"

#define PLUGIN_VERSION "0.2.0"

/** Bound on the SourceTV spectator slot index we will cache or emit. Matches
 *  the site parser's own slot bound (src/logParse.ts, 0-255) rather than any
 *  MAXPLAYERS constant: these are SourceTV client indices, a separate
 *  namespace from real game clients. */
#define TVWATCH_MAX_SLOT 256

/** Per-slot state cached at SourceTV_OnSpectatorConnected and read back from
 *  SourceTV_OnSpectatorDisconnected, which cannot re-fetch either. */
bool g_bSlotCached[TVWATCH_MAX_SLOT];
char g_sSlotName[TVWATCH_MAX_SLOT][128];

public Plugin myinfo = {
	name = "L4D1 SourceTV Watch",
	author = "Riverside",
	description = "Reports SourceTV spectator connects/disconnects and start/stop to the PUG site.",
	version = PLUGIN_VERSION,
	url = "https://riversidepug.com",
};

public void OnPluginStart()
{
	CreateConVar("l4d_tvwatch_version", PLUGIN_VERSION, "L4D1 SourceTV Watch version",
		FCVAR_NOTIFY | FCVAR_DONTRECORD);
	PugLogAuth_Init();
	CreateTimer(1.0, Timer_PollLeaves, _, TIMER_REPEAT);
}

/**
 * Leaves are found by polling, not by SourceTV_OnSpectatorDisconnected.
 *
 * Our SourceTV Manager build (1.2-riverside1) installs no per-spectator
 * hooks: on L4D1 a spectator whose Disconnect hook was carried through a
 * changelevel segfaulted srcds when it later timed out (bisected 2026-09-25
 * on Riverside #3). So the disconnect forward never fires; once a second each
 * cached slot is asked whether it is still connected, and a slot that is not
 * is reported with reason=left. The engine's own reason (timed out,
 * disconnect by user) is no longer available.
 *
 * The disconnect forward is still implemented below, so an unpatched
 * extension keeps working; whichever path sees the leave first clears the
 * cache, and the other then finds nothing to report.
 */
public Action Timer_PollLeaves(Handle timer)
{
	if (GetFeatureStatus(FeatureType_Native, "SourceTV_IsClientConnected") != FeatureStatus_Available)
		return Plugin_Continue;

	int count = SourceTV_GetClientCount();
	for (int slot = 1; slot < TVWATCH_MAX_SLOT; slot++)
	{
		if (!g_bSlotCached[slot]) continue;
		// A slot above the current count cannot hold a live client, and the
		// native would throw on it.
		if (slot <= count && SourceTV_IsClientConnected(slot)) continue;
		EmitLeave(slot, "left");
	}
	return Plugin_Continue;
}

public void SourceTV_OnServerStart(int instance)
{
	PugLog("PUGTV event=start");
}

public void SourceTV_OnServerShutdown(int instance)
{
	// The site already closes every open row on stop ('SourceTV restarted'),
	// so the cache is just dropped, not reported.
	for (int slot = 0; slot < TVWATCH_MAX_SLOT; slot++) g_bSlotCached[slot] = false;
	PugLog("PUGTV event=stop");
}

public void SourceTV_OnSpectatorConnected(int client)
{
	if (client <= 0 || client >= TVWATCH_MAX_SLOT) return;
	// The slot's previous occupant left inside the last poll interval and the
	// slot was handed straight to someone new: report that leave first.
	if (g_bSlotCached[client]) EmitLeave(client, "left");
	// Proxies are relays feeding other SourceTV instances, not people
	// watching; nothing here is interesting to an admin. Cleared, not left
	// as-is, so a missed leave for a real spectator that used to hold this
	// slot cannot have its stale cached name attributed to the proxy's own
	// later disconnect.
	if (SourceTV_IsClientProxy(client))
	{
		g_bSlotCached[client] = false;
		return;
	}

	char raw[128];
	SourceTV_GetClientName(client, raw, sizeof(raw));
	SanitizeText(raw, g_sSlotName[client], sizeof(g_sSlotName[]));
	g_bSlotCached[client] = true;

	char ip[64];
	SourceTV_GetClientIP(client, ip, sizeof(ip));
	StripPort(ip);

	char cc[3];
	cc[0] = '\0';
	if (GetFeatureStatus(FeatureType_Native, "GeoipCode2") == FeatureStatus_Available)
	{
		if (!GeoipCode2(ip, cc)) cc[0] = '\0';
	}

	if (cc[0] == '\0') PugLog("PUGTV event=join slot=%d ip=%s name=%s", client, ip, g_sSlotName[client]);
	else PugLog("PUGTV event=join slot=%d ip=%s cc=%s name=%s", client, ip, cc, g_sSlotName[client]);
}

public void SourceTV_OnSpectatorDisconnected(int client, const char reason[255])
{
	if (client <= 0 || client >= TVWATCH_MAX_SLOT) return;
	// Not cached: either a proxy (skipped at connect) or a disconnect for a
	// slot this plugin never saw connect (e.g. loaded mid-session). Either
	// way there is nothing trustworthy to attribute the line to.
	if (!g_bSlotCached[client]) return;
	EmitLeave(client, reason);
}

/** Reports a cached slot's leave once and clears the cache. The reason is
 *  free text from the engine, and on some builds player-reachable (the
 *  disconnect console command takes a message). Sanitised the same way as
 *  the name: control bytes stripped, '=' and '"' turned into '_', so it
 *  cannot forge a fake "name=" boundary or any other field on the line. */
void EmitLeave(int slot, const char[] reason)
{
	g_bSlotCached[slot] = false;
	char cleanReason[128];
	SanitizeText(reason, cleanReason, sizeof(cleanReason));
	PugLog("PUGTV event=leave slot=%d reason=%s name=%s", slot, cleanReason, g_sSlotName[slot]);
}

/** Strips a trailing ":port" from a SourceTV_GetClientIP result in place.
 *  L4D1 is IPv4-only, so the first colon is always the port separator. */
void StripPort(char[] ip)
{
	int colon = FindCharInString(ip, ':');
	if (colon >= 0) ip[colon] = '\0';
}

/**
 * Adapted from pug-match.sp's SanitizeName (plugin/pug-match.sp, around line
 * 2497): same byte filter, generalised to any input string rather than
 * fetching a real game client's name with GetClientName. SourceTV spectator
 * slots are not real game clients, so SourceTV_GetClientName (or the
 * disconnect reason string) is passed in already, not looked up here.
 *
 * Control bytes and byte 127 are dropped; '=' and '"' become '_' so the
 * result can never look like a field boundary to the site's line parser,
 * wherever it lands on the line. An empty result becomes "unknown".
 */
void SanitizeText(const char[] raw, char[] out, int maxlen)
{
	int w = 0;
	for (int i = 0; raw[i] != '\0' && w < maxlen - 1; i++)
	{
		if (raw[i] == '=' || raw[i] == '"') out[w++] = '_';
		else if (raw[i] >= 32 && raw[i] != 127) out[w++] = raw[i];
	}
	out[w] = '\0';
	if (w == 0) strcopy(out, maxlen, "unknown");
}
