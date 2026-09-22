/**
 * Signed log lines, shared by every plugin that talks to the PUG backend:
 * pug-match, l4d_inputstats, l4d_lilac_report and l4d_consistency.
 *
 * WHY. Everything these plugins report travels as srcds log lines over UDP.
 * The backend admits the token-less kinds (L4DC, L4DL, L4DM, PUGNET) on the
 * sender's address alone, and a UDP source address is what a spoofer forges:
 * anyone could plant a LilAC "banned" flag, macro bursts or a shared-address
 * sighting against any SteamID. The token on a PUG line is little better, since
 * it crosses the same cleartext stream. This engine has no sv_logsecret.
 *
 * WHAT. With a secret configured, PugLog() appends
 *
 *     lseq=<boot>.<n> mac=<8 hex>
 *
 * to the line. `mac` is the first four bytes of HMAC-SHA1(secret, everything on
 * the line before " mac="), so the counter is inside what is signed. `n` goes
 * up by one per line, for the whole server and not per plugin. `boot` is when
 * this srcds process first loaded one of these plugins, and it is on EVERY
 * line rather than in a start-up marker of its own: the stream is lossy, and a
 * marker that got dropped would leave the backend refusing the restarted
 * server's low counters for good. A line from an earlier boot, or one whose
 * counter it has already seen, is a replay. With no secret the line goes out
 * exactly as it always did, which is what a backend that predates this needs.
 *
 * The key is the secret's own characters, not the bytes its hex spells. Both
 * sides agree on that and it saves decoding here.
 *
 * It is `lseq`, not `seq`, because EVENT and CHAT lines already carry a
 * per-match `seq=`.
 *
 * HOW THE FOUR PLUGINS SHARE ONE COUNTER. Through ConVars. CreateConVar hands
 * back the existing ConVar when another plugin made it first, and SourceMod
 * never unregisters one, so the three below outlive any single plugin being
 * reloaded and die only with the process, which is exactly the lifetime a boot
 * stamp and its counter want.
 *
 *   sm_pug_log_secret  pushed by the backend over rcon. FCVAR_PROTECTED, so it
 *                      is never sent to a client.
 *   sm_pug_log_boot    set once, by whichever plugin loads first.
 *   sm_pug_log_seq     the last counter used.
 *
 * The secret is also kept in data/pug_logauth_<hostport>.txt and read back at
 * load, so a restarted server signs from its first line and not from its next
 * match set-up. Per port, because two srcds can share one install directory.
 *
 * USE. Call PugLogAuth_Init() from OnPluginStart, and PugLog() wherever
 * LogToGame() was called.
 */

#if defined _pug_logauth_included
 #endinput
#endif
#define _pug_logauth_included

#include "pug-hmac.inc"

/** Room PugLog keeps at the end of its buffer: " lseq=" + 10 + "." + 10 +
 *  " mac=" + 8 is 40. */
#define PUGLOG_TRAILER_ROOM 48

static ConVar g_cvPugLogSecret;
static ConVar g_cvPugLogBoot;
static ConVar g_cvPugLogSeq;
static PugHmac g_PugLogHmac;
static bool g_bPugLogLoadingFile;

void PugLogAuth_Init()
{
	g_cvPugLogSecret = CreateConVar("sm_pug_log_secret", "",
		"Shared secret the PUG backend pushes over rcon. Log lines are signed with it. Empty: lines go out unsigned.",
		FCVAR_PROTECTED | FCVAR_DONTRECORD | FCVAR_UNLOGGED);
	g_cvPugLogBoot = CreateConVar("sm_pug_log_boot", "0",
		"When this srcds process first loaded a PUG plugin (unix time). Set once; do not change.",
		FCVAR_DONTRECORD | FCVAR_UNLOGGED);
	g_cvPugLogSeq = CreateConVar("sm_pug_log_seq", "0",
		"Counter of signed log lines since sm_pug_log_boot. Do not change.",
		FCVAR_DONTRECORD | FCVAR_UNLOGGED);

	if (PugLogAuth_GetInt(g_cvPugLogBoot) == 0) PugLogAuth_SetInt(g_cvPugLogBoot, GetTime());

	// Hooked before the file is read, so loading it keys this plugin too.
	g_cvPugLogSecret.AddChangeHook(PugLogAuth_OnSecretChanged);

	char secret[65];
	g_cvPugLogSecret.GetString(secret, sizeof(secret));
	if (secret[0] != '\0')
	{
		PugLogAuth_Rekey(secret);
		return;
	}
	if (PugLogAuth_ReadFile(secret, sizeof(secret)))
	{
		g_bPugLogLoadingFile = true;
		g_cvPugLogSecret.SetString(secret);
		g_bPugLogLoadingFile = false;
	}
}

/** LogToGame, signed when a secret is configured. */
void PugLog(const char[] fmt, any ...)
{
	char line[1024];
	int len = VFormat(line, sizeof(line) - PUGLOG_TRAILER_ROOM, fmt, 2);
	if (g_PugLogHmac.keyed)
	{
		int seq = PugLogAuth_GetInt(g_cvPugLogSeq) + 1;
		PugLogAuth_SetInt(g_cvPugLogSeq, seq);
		len += Format(line[len], sizeof(line) - len, " lseq=%d.%d", PugLogAuth_GetInt(g_cvPugLogBoot), seq);
		char mac[9];
		g_PugLogHmac.Hex(line, len, 4, mac);
		Format(line[len], sizeof(line) - len, " mac=%s", mac);
	}
	LogToGame("%s", line);
}

/** Through the ConVar's STRING, both ways. Its integer view is filled in from
 *  a float whenever the value was set as text, and a float cannot hold a unix
 *  time exactly; the string is always what was written. */
static int PugLogAuth_GetInt(ConVar cv)
{
	char buf[16];
	cv.GetString(buf, sizeof(buf));
	return StringToInt(buf);
}

static void PugLogAuth_SetInt(ConVar cv, int value)
{
	char buf[16];
	IntToString(value, buf, sizeof(buf));
	cv.SetString(buf);
}

static void PugLogAuth_OnSecretChanged(ConVar cv, const char[] oldValue, const char[] newValue)
{
	PugLogAuth_Rekey(newValue);
	if (!g_bPugLogLoadingFile) PugLogAuth_WriteFile(newValue);
}

/** 32 to 64 hex digits, or it is not a secret and lines go out unsigned:
 *  signing with something the backend never issued would only look like
 *  forgery at the other end. */
static void PugLogAuth_Rekey(const char[] secret)
{
	int len = strlen(secret);
	bool ok = len >= 32 && len <= 64;
	for (int i = 0; ok && i < len; i++)
	{
		bool digit = secret[i] >= '0' && secret[i] <= '9';
		bool hex = secret[i] >= 'a' && secret[i] <= 'f';
		if (!digit && !hex) ok = false;
	}
	if (ok) g_PugLogHmac.SetKey(secret, len);
	else g_PugLogHmac.Clear();
}

static void PugLogAuth_Path(char[] path, int maxlen)
{
	ConVar hostport = FindConVar("hostport");
	BuildPath(Path_SM, path, maxlen, "data/pug_logauth_%d.txt", hostport != null ? hostport.IntValue : 0);
}

static bool PugLogAuth_ReadFile(char[] secret, int maxlen)
{
	char path[PLATFORM_MAX_PATH];
	PugLogAuth_Path(path, sizeof(path));
	if (!FileExists(path)) return false;
	File f = OpenFile(path, "r");
	if (f == null) return false;
	bool got = f.ReadLine(secret, maxlen);
	delete f;
	if (!got) return false;
	TrimString(secret);
	return secret[0] != '\0';
}

/** Every plugin that is loaded writes the same bytes; that is harmless and
 *  cheaper than electing one. An empty secret removes the file, so turning
 *  signing off survives a restart as well. */
static void PugLogAuth_WriteFile(const char[] secret)
{
	char path[PLATFORM_MAX_PATH];
	PugLogAuth_Path(path, sizeof(path));
	if (secret[0] == '\0')
	{
		if (FileExists(path)) DeleteFile(path);
		return;
	}
	File f = OpenFile(path, "w");
	if (f == null)
	{
		LogError("[pug-logauth] could not write %s; the log secret will not survive a restart", path);
		return;
	}
	f.WriteLine("%s", secret);
	delete f;
}
