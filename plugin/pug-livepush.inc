// pug-livepush.inc: send the round being recorded to the site, once a second,
// so the live viewer works on servers the site does not share a disk with.
//
// Included by pug-match.sp below the replay globals, because it reads
// g_State. Everything here is optional. With sm_pug_live_push 0 (the default)
// or with REST in Pawn not loaded, LivePushOpen leaves the round inactive,
// every other entry point returns at its first line, and the recorder writes
// exactly the file it wrote before this existed.
//
// LOADING THE EXTENSION (opt in per server). This plugin NEVER loads rip.ext
// by itself: the vendored include/ripext.inc is modified to autoload = 0 and
// required = 0, so staging pug-match on a live server does not load the
// extension. A server opts in with BOTH of:
//   1. REST in Pawn loaded BEFORE pug-match loads. SourceMod binds an
//      extension's natives to a plugin only when the plugin loads; an
//      extension loaded later (for example `sm exts load rip.ext.so` from a
//      cfg, which runs after plugins load) stays unbound for this plugin until
//      it is reloaded. So either create the empty file
//      addons/sourcemod/extensions/rip.autoload and restart srcds, or run
//      `sm exts load rip.ext.so` and then `sm plugins reload pug-match` on an
//      empty server.
//   2. sm_pug_live_push 1 (in the server's cfg, and over rcon for now).
// `sm_pug_status` prints `STATUS livepush ... lib=<ripext library present>
// bound=<natives bound to this plugin>`; pushing needs bound=1.
//
// Shape of the stream: the site keeps a copy of the file that is always an
// exact prefix of it. The plugin keeps every byte the site has not confirmed
// in a ring, posts them from the confirmed offset, and moves the confirmed
// offset to whatever length the site answers with. One request at a time.
// Every batch names its round by `started`, the startedUnix written into the
// header at byte 76, so the site can tell a restarted round from the old one.

// Optional, the same way geoip is at the top of pug-match.sp. The include's
// Extension entry is fixed at autoload = 0, required = 0 (see above), so these
// defines no longer change anything; they stay as a second guard.
#undef REQUIRE_EXTENSIONS
#include <ripext>
#define REQUIRE_EXTENSIONS

/** Unconfirmed bytes kept: about 60 seconds at the busiest rate a round writes
 *  (a full entity block every frame is about 17 KB/s; a typical round is 5). */
#define LP_CAP          327680
/** Raw bytes per request. Base64 makes this exactly 65536 characters, which is
 *  what the site's 64 KiB data cap and 128 KiB body cap are sized around. */
#define LP_BATCH_MAX    49152
#define LP_B64_LEN      65537
/** A request with no callback after this long is written off. ripext calls
 *  back on every outcome, including a timeout, so this is a backstop. */
#define LP_STUCK_SECS   15

ConVar g_cvLivePush;
ConVar g_cvLivePushUrl;
bool g_bLpRipExt;

char g_sLpRing[LP_CAP];          // file byte o is at g_sLpRing[o % LP_CAP]
char g_sLpB64[LP_B64_LEN];
char g_sLpAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int g_iLpRound;                  // bumped by every LivePushOpen: a reply names its round by this
bool g_bLpActive;                // this round is being pushed
int g_iLpBase;                   // first file byte the site has not confirmed
int g_iLpEnd;                    // one past the last file byte appended
bool g_bLpClosed;                // RplClose has run for this round
bool g_bLpHasFinal;              // ... and patched the header, with these values
int g_iLpFinal[3];               // indexOffset, indexCount, frameCount
char g_sLpToken[65];
int g_iLpOrdinal;
int g_iLpHalf;
int g_iLpStarted;                // the header's startedUnix: the round's identity on the site

bool g_bLpInFlight;
int g_iLpSeq;                    // bumped for every request; the callback's value
int g_iLpInFlightSeq;
int g_iLpInFlightRound;
int g_iLpInFlightOffset;         // the offset the request in flight was sent from
bool g_bLpInFlightClosed;
int g_iLpInFlightAt;

void LivePushInit()
{
	g_cvLivePush = CreateConVar("sm_pug_live_push", "0",
		"1 = send the round being recorded to the site once a second, for the live viewer. Needs the REST in Pawn extension loaded before this plugin; without it this does nothing. Takes effect at the next round.",
		FCVAR_NOTIFY, true, 0.0, true, 1.0);
	g_cvLivePushUrl = CreateConVar("sm_pug_live_push_url", "https://riversidepug.com/api/replays/push",
		"Where live replay bytes are posted. The box that hosts the site posts to itself over 127.0.0.1 instead.",
		FCVAR_NONE);
	g_bLpRipExt = LibraryExists("ripext");
	// Not TIMER_FLAG_NO_MAPCHANGE: this has to outlive every map change, and
	// the final batch of a round is often sent after its map has ended.
	CreateTimer(1.0, Timer_LivePush, _, TIMER_REPEAT);
}

/** Called from AskPluginLoad2. The extension is optional, and a plugin that
 *  references an unbound native without this refuses to load. Every native
 *  this file calls is listed; adding a call means adding its name here. */
void LivePushMarkOptional()
{
	MarkNativeAsOptional("HTTPRequest.HTTPRequest");
	MarkNativeAsOptional("HTTPRequest.Post");
	MarkNativeAsOptional("HTTPRequest.ConnectTimeout.set");
	MarkNativeAsOptional("HTTPRequest.Timeout.set");
	MarkNativeAsOptional("HTTPResponse.Status.get");
	MarkNativeAsOptional("HTTPResponse.Data.get");
	MarkNativeAsOptional("JSONObject.JSONObject");
	MarkNativeAsOptional("JSONObject.SetString");
	MarkNativeAsOptional("JSONObject.SetInt");
	MarkNativeAsOptional("JSONObject.SetBool");
	MarkNativeAsOptional("JSONObject.Set");
	MarkNativeAsOptional("JSONObject.HasKey");
	MarkNativeAsOptional("JSONObject.GetInt");
	MarkNativeAsOptional("JSONObject.GetString");
}

void LivePushLibrary(const char[] name, bool present)
{
	if (StrEqual(name, "ripext")) g_bLpRipExt = present;
}

/** Whether the natives are bound to THIS plugin. The library being present is
 *  not enough: an extension loaded after the plugin is never bound to it. */
static bool LpNativesBound()
{
	return GetFeatureStatus(FeatureType_Native, "HTTPRequest.Post") == FeatureStatus_Available;
}

static bool LpRipReady()
{
	return g_bLpRipExt && LpNativesBound();
}

/** A round's file was opened and its header written. The header's bytes
 *  follow through LivePushAppend like every other write. `started` is the
 *  startedUnix the header carries at byte 76. */
void LivePushOpen(const char[] token, int ordinal, int half, int started)
{
	g_iLpRound++;
	g_bLpActive = g_cvLivePush.BoolValue && LpRipReady() && g_State == MS_Live && token[0] != '\0';
	g_iLpBase = 0;
	g_iLpEnd = 0;
	g_bLpClosed = false;
	g_bLpHasFinal = false;
	strcopy(g_sLpToken, sizeof(g_sLpToken), token);
	g_iLpOrdinal = ordinal;
	g_iLpHalf = half;
	g_iLpStarted = started;
}

/** Bytes the recorder just wrote to the file, in file order: one byte per
 *  cell, the recorder's own buffer layout. */
void LivePushAppend(const int[] bytes, int n)
{
	if (!g_bLpActive || n <= 0) return;
	if (g_iLpEnd + n - g_iLpBase > LP_CAP)
	{
		// The site has confirmed nothing for about a minute. Give up on this
		// round rather than grow; the copy job brings the whole file anyway.
		g_bLpActive = false;
		LogMessage("pug: live push is %d bytes behind; stopped for this round", g_iLpEnd + n - g_iLpBase);
		return;
	}
	int pos = g_iLpEnd % LP_CAP;
	for (int i = 0; i < n; i++)
	{
		g_sLpRing[pos] = bytes[i] & 0xFF;
		if (++pos == LP_CAP) pos = 0;
	}
	g_iLpEnd += n;
}

/** The recorder closed the file. `patched` is whether the header now carries
 *  the index and frame count, which the site then writes into its copy so the
 *  two stay byte for byte the same. `fileBytes` is the file's full length,
 *  checked against what went through the ring. */
void LivePushClose(bool patched, int indexOffset, int indexCount, int frames, int fileBytes)
{
	if (!g_bLpActive) return;
	if (patched && fileBytes != g_iLpEnd)
	{
		LogError("pug: live push saw %d bytes of a %d byte file; stopped for this round", g_iLpEnd, fileBytes);
		g_bLpActive = false;
		return;
	}
	g_bLpClosed = true;
	g_bLpHasFinal = patched;
	g_iLpFinal[0] = indexOffset;
	g_iLpFinal[1] = indexCount;
	g_iLpFinal[2] = frames;
}

/** One line for sm_pug_status. */
void LivePushStatus()
{
	DumpLine("STATUS livepush on=%d lib=%d bound=%d active=%d base=%d end=%d closed=%d inflight=%d",
		g_cvLivePush.BoolValue ? 1 : 0, g_bLpRipExt ? 1 : 0, LpNativesBound() ? 1 : 0,
		g_bLpActive ? 1 : 0, g_iLpBase, g_iLpEnd, g_bLpClosed ? 1 : 0, g_bLpInFlight ? 1 : 0);
}

public Action Timer_LivePush(Handle timer)
{
	if (g_bLpInFlight)
	{
		if (GetTime() - g_iLpInFlightAt < LP_STUCK_SECS) return Plugin_Continue;
		// Written off. Clearing the slot's sequence number is what makes a
		// late callback for it be ignored.
		g_bLpInFlight = false;
		g_iLpInFlightSeq = 0;
	}
	if (!g_bLpActive || !g_cvLivePush.BoolValue || !LpRipReady()) return Plugin_Continue;
	if (g_iLpEnd == g_iLpBase && !g_bLpClosed) return Plugin_Continue;
	LpSend();
	return Plugin_Continue;
}

static void LpSend()
{
	char url[256];
	g_cvLivePushUrl.GetString(url, sizeof(url));
	if (url[0] == '\0') return;

	int count = g_iLpEnd - g_iLpBase;
	if (count > LP_BATCH_MAX) count = LP_BATCH_MAX;
	bool closing = g_bLpClosed && g_iLpBase + count == g_iLpEnd;
	LpBase64(g_iLpBase, count, g_sLpB64, sizeof(g_sLpB64));

	JSONObject body = new JSONObject();
	body.SetString("token", g_sLpToken);
	body.SetInt("ordinal", g_iLpOrdinal);
	body.SetInt("half", g_iLpHalf);
	body.SetInt("offset", g_iLpBase);
	body.SetInt("started", g_iLpStarted);
	body.SetBool("closed", closing);
	body.SetString("data", g_sLpB64);
	if (closing && g_bLpHasFinal)
	{
		JSONObject fin = new JSONObject();
		fin.SetInt("indexOffset", g_iLpFinal[0]);
		fin.SetInt("indexCount", g_iLpFinal[1]);
		fin.SetInt("frameCount", g_iLpFinal[2]);
		body.Set("final", fin);   // json_object_set takes its own reference
		delete fin;
	}

	HTTPRequest req = new HTTPRequest(url);
	req.ConnectTimeout = 3;
	req.Timeout = 5;
	g_iLpSeq++;
	g_bLpInFlight = true;
	g_iLpInFlightSeq = g_iLpSeq;
	g_iLpInFlightRound = g_iLpRound;
	g_iLpInFlightOffset = g_iLpBase;
	g_bLpInFlightClosed = closing;
	g_iLpInFlightAt = GetTime();
	// Post serialises the body before it returns (HTTPRequestContext's
	// constructor calls json_dumps), so the handle is ours to free now.
	req.Post(body, LpOnReply, g_iLpSeq);
	delete body;
}

/**
 * The site's answers (src/routes/replays.ts, src/replayPush.ts):
 *   200 { length }   accepted (or already held); length is the copy's size.
 *   409 { length }   the copy is `length` bytes and the batch did not start
 *                    there: resume from it. A 409 may also mean "stale round"
 *                    (the copy belongs to a different round); the route may
 *                    or may not send that as `error`, so both the text and
 *                    its unmistakable shape (the site refused a batch that
 *                    started exactly at its own length) stop the round.
 *   400/404/413      bad batch, no live match, too large: stop the round.
 *   507              the live store is full: stop the round.
 *   503, other 5xx,  temporarily unavailable, no connection, timeout: send
 *   408, 429, 0      again from the confirmed offset next second.
 */
public void LpOnReply(HTTPResponse response, any seq, const char[] error)
{
	// Only the request that holds the slot may free it: one written off by
	// the timer must not clear the flag of the request sent after it.
	if (seq != g_iLpInFlightSeq) return;
	g_bLpInFlight = false;
	// A reply for a round that is over says nothing about this one.
	if (g_iLpInFlightRound != g_iLpRound || !g_bLpActive) return;

	int code = view_as<int>(response.Status);
	if (code == 200)
	{
		int length = LpReplyLength(response);
		if (length > g_iLpBase && length <= g_iLpEnd) g_iLpBase = length;
		// The site has every byte of a closed round: nothing left to do.
		if (g_bLpInFlightClosed && length == g_iLpEnd) g_bLpActive = false;
		return;
	}
	if (code == 409)
	{
		int length = LpReplyLength(response);
		if (LpReplyIsStale(response) || length == g_iLpInFlightOffset)
		{
			// The site's copy is another round's. Resending cannot change
			// that: the offset rule only helps within one round.
			g_bLpActive = false;
			PugDebug("live push: site holds a different round (%d bytes); stopped for this round", length);
			return;
		}
		// The site holds a different length than we sent from. Resume from
		// it when it is a length we can still send from.
		if (length >= g_iLpBase && length <= g_iLpEnd) g_iLpBase = length;
		else
		{
			g_bLpActive = false;
			PugDebug("live push: site holds %d bytes, outside %d..%d; stopped for this round", length, g_iLpBase, g_iLpEnd);
		}
		return;
	}
	if (code == 507 || (code >= 400 && code < 500 && code != 408 && code != 429))
	{
		// Not a live match, a bad batch, too large, or no room: retrying
		// cannot help.
		g_bLpActive = false;
		PugDebug("live push: refused with %d; stopped for this round", code);
		return;
	}
	// 0 (no connection, timeout), 503 or another 5xx, 408, 429: the next
	// second resends from the confirmed offset. Nothing is queued.
	PugDebug("live push: no answer (%d %s); retrying", code, error);
}

static int LpReplyLength(HTTPResponse response)
{
	// Owned by the response and freed by ripext after this callback returns.
	JSONObject data = view_as<JSONObject>(response.Data);
	if (data == null || !data.HasKey("length")) return -1;
	return data.GetInt("length");
}

static bool LpReplyIsStale(HTTPResponse response)
{
	JSONObject data = view_as<JSONObject>(response.Data);
	if (data == null || !data.HasKey("error")) return false;
	char err[64];
	if (!data.GetString("error", err, sizeof(err))) return false;
	return StrContains(err, "stale round") != -1;
}

/** Base64 of `count` ring bytes starting at file byte `from`. */
static void LpBase64(int from, int count, char[] out, int maxlen)
{
	int o = 0;
	int i = 0;
	while (i + 3 <= count && o + 4 < maxlen)
	{
		int v = (LpByte(from + i) << 16) | (LpByte(from + i + 1) << 8) | LpByte(from + i + 2);
		out[o++] = g_sLpAlphabet[(v >> 18) & 63];
		out[o++] = g_sLpAlphabet[(v >> 12) & 63];
		out[o++] = g_sLpAlphabet[(v >> 6) & 63];
		out[o++] = g_sLpAlphabet[v & 63];
		i += 3;
	}
	int rest = count - i;
	if (rest > 0 && o + 4 < maxlen)
	{
		int v = LpByte(from + i) << 16;
		if (rest == 2) v |= LpByte(from + i + 1) << 8;
		out[o++] = g_sLpAlphabet[(v >> 18) & 63];
		out[o++] = g_sLpAlphabet[(v >> 12) & 63];
		if (rest == 2) out[o++] = g_sLpAlphabet[(v >> 6) & 63];
		else out[o++] = '=';
		out[o++] = '=';
	}
	out[o] = '\0';
}

static int LpByte(int fileOffset)
{
	return g_sLpRing[fileOffset % LP_CAP] & 0xFF;
}
