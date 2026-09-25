// Balance inventory: what this server is running, sent at every go-live so
// the backend can tag the round with a patch and spot drift between servers.
// See docs/superpowers/specs/2026-09-23-balance-analytics-design.md.
//
// Files are hashed with FNV-1a 32, not SHA-1: this is change detection, not
// security, and pure-SourcePawn SHA-1 is about twenty times slower per byte.
// The static part (plugins, files, dirs) is scanned at map start and cached by
// (name, size, mtime), so an unchanged file is read once per server boot.

#include "pug-balance-list.inc"

#define BAL_FNV_OFFSET -2128831035   // 0x811C9DC5 as a signed cell
#define BAL_FNV_PRIME  16777619
#define BAL_LINE_MAX   600

ArrayList g_hBalStatic;      // "p:..=..", "f:..=..", "d:..=..", "w:..=.." items, rebuilt each map
// The watch list: read from data/pug_balance_watch.txt at every map start (the
// site writes it), else the compiled lists in pug-balance-list.inc. See
// docs/superpowers/specs/2026-09-24-balance-watch-file-design.md.
ArrayList g_hWatchCvars, g_hWatchFiles, g_hWatchDirs, g_hWatchDirExt, g_hWatchWeapons;
bool g_bWatchFromFile;

#define BAL_WATCH_MAX_CVARS   512
#define BAL_WATCH_MAX_FILES   64
#define BAL_WATCH_MAX_DIRS    16
#define BAL_WATCH_MAX_WEAPONS 256
StringMap g_hBalCache;       // path -> "size.mtime.hash8" so unchanged files are not reread
int g_iBalBuf[4096];         // global, not local: 16 KB is too big for the plugin stack

static int BalFold(int h, int b)
{
	h ^= (b & 0xFF);
	return h * BAL_FNV_PRIME;
}

static int BalFoldString(int h, const char[] s)
{
	for (int i = 0; s[i] != '\0'; i++) h = BalFold(h, s[i]);
	return h;
}

/** Fold a file's bytes into h. Returns the byte count, or -1 if unreadable. */
static int BalFoldFile(const char[] path, int &h)
{
	File f = OpenFile(path, "rb");
	if (f == null) return -1;
	int size = 0, n;
	while ((n = f.Read(g_iBalBuf, sizeof(g_iBalBuf), 1)) > 0)
	{
		for (int i = 0; i < n; i++) h = BalFold(h, g_iBalBuf[i]);
		size += n;
	}
	delete f;
	return size;
}

/** "size.hash8" for one file, from the cache when size and mtime are unchanged. */
static bool BalFileValue(const char[] path, char[] out, int maxlen)
{
	if (!FileExists(path)) return false;
	int size = FileSize(path);
	int mtime = GetFileTime(path, FileTime_LastChange);
	char cached[64], keyv[32];
	Format(keyv, sizeof(keyv), "%d.%d.", size, mtime);
	if (g_hBalCache.GetString(path, cached, sizeof(cached)) && StrContains(cached, keyv) == 0)
	{
		Format(out, maxlen, "%d.%s", size, cached[strlen(keyv)]);
		return true;
	}
	int h = BAL_FNV_OFFSET;
	int got = BalFoldFile(path, h);
	if (got < 0) return false;
	Format(cached, sizeof(cached), "%s%08x", keyv, h);
	g_hBalCache.SetString(path, cached);
	Format(out, maxlen, "%d.%08x", got, h);
	return true;
}

/** Percent-encode exactly '%' and ' ' (the backend decodes exactly those). */
static void BalEncode(const char[] src, char[] dst, int maxlen)
{
	int j = 0;
	for (int i = 0; src[i] != '\0' && j < maxlen - 4; i++)
	{
		if (src[i] == '%') { dst[j++] = '%'; dst[j++] = '2'; dst[j++] = '5'; }
		else if (src[i] == ' ') { dst[j++] = '%'; dst[j++] = '2'; dst[j++] = '0'; }
		else dst[j++] = src[i];
	}
	dst[j] = '\0';
}

static void BalPush(const char[] prefix, const char[] key, const char[] value)
{
	char k[256], v[128], item[400];
	BalEncode(key, k, sizeof(k));
	BalEncode(value, v, sizeof(v));
	Format(item, sizeof(item), "%s:%s=%s", prefix, k, v);
	g_hBalStatic.PushString(item);
}

/** "count.hash8" over every file with the extension, names sorted, each name
 *  and that file's cached "size.hash8" folded in, so a rename, an edit, an add
 *  or a delete all show. Folding the per-file value rather than the raw bytes
 *  lets the (name, size, mtime) cache cover the directory too: measured on a
 *  local srcds with 139 stripper configs (4.1 MB), rehashing the bytes cost
 *  about 77 ms at EVERY map start; with the cache only the first map pays. */
static void BalScanDir(const char[] dir, const char[] ext, char[] out, int maxlen)
{
	ArrayList names = new ArrayList(ByteCountToCells(PLATFORM_MAX_PATH));
	DirectoryListing dl = OpenDirectory(dir);
	if (dl != null)
	{
		char entry[PLATFORM_MAX_PATH];
		FileType ft;
		while (dl.GetNext(entry, sizeof(entry), ft))
		{
			if (ft == FileType_File && StrEndsWith(entry, ext)) names.PushString(entry);
		}
		delete dl;
	}
	names.SortCustom(BalSortNames);
	int h = BAL_FNV_OFFSET;
	char entry2[PLATFORM_MAX_PATH], full[PLATFORM_MAX_PATH], value[64];
	for (int i = 0; i < names.Length; i++)
	{
		names.GetString(i, entry2, sizeof(entry2));
		h = BalFoldString(h, entry2);
		h = BalFold(h, 0);
		Format(full, sizeof(full), "%s/%s", dir, entry2);
		if (!BalFileValue(full, value, sizeof(value))) strcopy(value, sizeof(value), "missing");
		h = BalFoldString(h, value);
		h = BalFold(h, 0);
	}
	Format(out, maxlen, "%d.%08x", names.Length, h);
	delete names;
}

// SortCustom's callback typedef takes the array as a plain Handle (see
// sorting.inc's SortFuncADTArray), not ArrayList, so the parameter is
// declared that way here and cast inside; declaring it ArrayList does not
// match the typedef and fails to bind as the SortCustom argument.
static int BalSortNames(int a, int b, Handle array, Handle hndl)
{
	char x[PLATFORM_MAX_PATH], y[PLATFORM_MAX_PATH];
	ArrayList arr = view_as<ArrayList>(array);
	arr.GetString(a, x, sizeof(x));
	arr.GetString(b, y, sizeof(y));
	return strcmp(x, y);
}

static bool StrEndsWith(const char[] s, const char[] suffix)
{
	int ls = strlen(s), lx = strlen(suffix);
	return ls >= lx && StrEqual(s[ls - lx], suffix, false);
}

/** Fill the watch lists from data/pug_balance_watch.txt, or from the compiled
 *  lists when the file is missing, unreadable or lists nothing. One entry per
 *  line: "cvar <name>", "file <path>", "dir <path> <ext>" or
 *  "weapon <classname> <key>"; "//" comments, blank lines and unknown kinds
 *  are skipped, so a newer site can add kinds this plugin ignores. */
static void BalanceLoadWatch()
{
	if (g_hWatchCvars == null)
	{
		g_hWatchCvars = new ArrayList(ByteCountToCells(64));
		g_hWatchFiles = new ArrayList(ByteCountToCells(PLATFORM_MAX_PATH));
		g_hWatchDirs = new ArrayList(ByteCountToCells(PLATFORM_MAX_PATH));
		g_hWatchDirExt = new ArrayList(ByteCountToCells(16));
		g_hWatchWeapons = new ArrayList(ByteCountToCells(160));
	}
	g_hWatchCvars.Clear(); g_hWatchFiles.Clear(); g_hWatchDirs.Clear(); g_hWatchDirExt.Clear(); g_hWatchWeapons.Clear();
	g_bWatchFromFile = false;

	char path[PLATFORM_MAX_PATH];
	BuildPath(Path_SM, path, sizeof(path), "data/pug_balance_watch.txt");
	File f = OpenFile(path, "r");
	if (f != null)
	{
		char line[400], parts[3][PLATFORM_MAX_PATH], entry[160];
		bool overflow = false;
		while (f.ReadLine(line, sizeof(line)))
		{
			TrimString(line);
			if (line[0] == '\0' || (line[0] == '/' && line[1] == '/')) continue;
			int n = ExplodeString(line, " ", parts, sizeof(parts), sizeof(parts[]));
			if (n >= 2 && StrEqual(parts[0], "cvar"))
			{
				if (g_hWatchCvars.Length < BAL_WATCH_MAX_CVARS) g_hWatchCvars.PushString(parts[1]); else overflow = true;
			}
			else if (n >= 2 && StrEqual(parts[0], "file"))
			{
				if (g_hWatchFiles.Length < BAL_WATCH_MAX_FILES) g_hWatchFiles.PushString(parts[1]); else overflow = true;
			}
			else if (n >= 3 && StrEqual(parts[0], "dir"))
			{
				if (g_hWatchDirs.Length < BAL_WATCH_MAX_DIRS) { g_hWatchDirs.PushString(parts[1]); g_hWatchDirExt.PushString(parts[2]); } else overflow = true;
			}
			else if (n >= 3 && StrEqual(parts[0], "weapon"))
			{
				if (g_hWatchWeapons.Length < BAL_WATCH_MAX_WEAPONS)
				{
					Format(entry, sizeof(entry), "%s %s", parts[1], parts[2]);
					g_hWatchWeapons.PushString(entry);
				}
				else overflow = true;
			}
		}
		delete f;
		if (overflow) LogError("pug_balance_watch.txt lists more than this plugin reads; the extra entries were skipped");
		g_bWatchFromFile = g_hWatchCvars.Length + g_hWatchFiles.Length + g_hWatchDirs.Length + g_hWatchWeapons.Length > 0;
	}
	if (!g_bWatchFromFile)
	{
		g_hWatchCvars.Clear(); g_hWatchFiles.Clear(); g_hWatchDirs.Clear(); g_hWatchDirExt.Clear(); g_hWatchWeapons.Clear();
		for (int i = 0; i < sizeof(g_sBalCvars); i++) g_hWatchCvars.PushString(g_sBalCvars[i]);
		for (int i = 0; i < sizeof(g_sBalFiles); i++) g_hWatchFiles.PushString(g_sBalFiles[i]);
		for (int i = 0; i < sizeof(g_sBalDirs); i++) { g_hWatchDirs.PushString(g_sBalDirs[i]); g_hWatchDirExt.PushString(g_sBalDirExt[i]); }
	}
}

/** Whether s is a plain decimal number: an optional '-', digits, and at
 *  most one '.' with at least one digit somewhere. */
static bool BalIsDecimal(const char[] s)
{
	int i = (s[0] == '-') ? 1 : 0, digits = 0, dots = 0;
	for (; s[i] != '\0'; i++)
	{
		if (s[i] >= '0' && s[i] <= '9') digits++;
		else if (s[i] == '.' && dots == 0) dots++;
		else return false;
	}
	return digits > 0;
}

/** KeyValues stores "0.22" as a float and GetString gives back "0.220000":
 *  drop the trailing zeros (and a bare trailing dot) so the site sees the
 *  number as written, "0.22" (and "2.0" becomes "2"). Only a whole value
 *  that is a number: a string such as "v1.10" is left exactly as it is. */
static void BalTrimFloat(char[] s)
{
	if (StrContains(s, ".") == -1 || !BalIsDecimal(s)) return;
	int n = strlen(s);
	while (n > 0 && s[n - 1] == '0') s[--n] = '\0';
	if (n > 0 && s[n - 1] == '.') s[--n] = '\0';
}

/** Weapon keys from l4d_info_editor's data file ("weapon_info" > "all" >
 *  classname > key), "default" when the file does not set one: the game's own
 *  value applies. Map-specific sections are not read. */
static void BalanceScanWeapons()
{
	if (g_hWatchWeapons.Length == 0) return;
	char path[PLATFORM_MAX_PATH];
	BuildPath(Path_SM, path, sizeof(path), "data/l4d_info_editor_weapons.cfg");
	KeyValues kv = new KeyValues("weapon_info");
	bool loaded = FileExists(path) && kv.ImportFromFile(path);
	char entry[160], parts[2][80], key[160], value[64];
	for (int i = 0; i < g_hWatchWeapons.Length; i++)
	{
		g_hWatchWeapons.GetString(i, entry, sizeof(entry));
		if (ExplodeString(entry, " ", parts, sizeof(parts), sizeof(parts[])) < 2) continue;
		value[0] = '\0';
		if (loaded)
		{
			kv.Rewind();
			if (kv.JumpToKey("all") && kv.JumpToKey(parts[0])) kv.GetString(parts[1], value, sizeof(value), "");
		}
		if (value[0] == '\0') strcopy(value, sizeof(value), "default");
		else BalTrimFloat(value);
		Format(key, sizeof(key), "%s.%s", parts[0], parts[1]);
		BalPush("w", key, value);
		PugDebug("balance weapon %s = %s", key, value);
	}
	delete kv;
}

/** Map start: the watch list, plugins, listed files and directories, weapon keys. */
void BalanceScanStatic()
{
	if (g_hBalStatic == null) g_hBalStatic = new ArrayList(ByteCountToCells(400));
	if (g_hBalCache == null) g_hBalCache = new StringMap();
	g_hBalStatic.Clear();
	float t0 = GetEngineTime();
	BalanceLoadWatch();

	char name[PLATFORM_MAX_PATH], path[PLATFORM_MAX_PATH], value[64];
	Handle it = GetPluginIterator();
	while (MorePlugins(it))
	{
		Handle pl = ReadPlugin(it);
		// A plugin that failed to load (a missing extension, say) can come
		// back as a null handle, and every plugin native reads null as "the
		// calling plugin": it would be listed as a running pug-match.smx.
		// Seen on a local srcds with nine failed plugins: nine extra
		// p:pug-match.smx items on the BALANCE lines.
		if (pl == null || GetPluginStatus(pl) != Plugin_Running) continue;
		GetPluginFilename(pl, name, sizeof(name));
		BuildPath(Path_SM, path, sizeof(path), "plugins/%s", name);
		if (BalFileValue(path, value, sizeof(value))) BalPush("p", name, value);
	}
	delete it;

	char file[PLATFORM_MAX_PATH], ext[16];
	for (int i = 0; i < g_hWatchFiles.Length; i++)
	{
		g_hWatchFiles.GetString(i, file, sizeof(file));
		if (!BalFileValue(file, value, sizeof(value))) strcopy(value, sizeof(value), "missing");
		BalPush("f", file, value);
	}

	for (int i = 0; i < g_hWatchDirs.Length; i++)
	{
		g_hWatchDirs.GetString(i, file, sizeof(file));
		g_hWatchDirExt.GetString(i, ext, sizeof(ext));
		BalScanDir(file, ext, value, sizeof(value));
		BalPush("d", file, value);
	}

	BalanceScanWeapons();

	PugDebug("balance scan: %d items from the %s list in %.1f ms", g_hBalStatic.Length,
		g_bWatchFromFile ? "file" : "builtin", (GetEngineTime() - t0) * 1000.0);
}

/** Append one item, flushing the line first when it would reach BAL_LINE_MAX,
 *  so a line body always stays strictly under 600 bytes. */
static void BalAppend(char[] line, int maxlen, const char[] item, int &part, int &items, bool &dirty)
{
	if (dirty && strlen(line) + strlen(item) + 1 >= BAL_LINE_MAX)
	{
		EmitPug("%s", line);
		part++;
		Format(line, maxlen, "BALANCE half=%d part=%d", g_iHalf, part);
		dirty = false;
	}
	StrCat(line, maxlen, " ");
	StrCat(line, maxlen, item);
	items++;
	dirty = true;
}

/** Go-live: cvars read now (they can change over rcon between rounds), the
 *  static items as scanned at map start. */
void EmitBalance()
{
	if (g_hBalStatic == null) BalanceScanStatic();
	char line[768], item[400], val[128], enc[256];
	int part = 0, items = 0;
	bool dirty = false;
	Format(line, sizeof(line), "BALANCE half=%d part=%d", g_iHalf, part);

	char name[64];
	for (int i = 0; i < g_hWatchCvars.Length; i++)
	{
		g_hWatchCvars.GetString(i, name, sizeof(name));
		ConVar cv = FindConVar(name);
		if (cv == null) Format(item, sizeof(item), "x:%s=missing", name);
		else
		{
			cv.GetString(val, sizeof(val));
			BalEncode(val, enc, sizeof(enc));
			Format(item, sizeof(item), "c:%s=%s", name, enc);
		}
		BalAppend(line, sizeof(line), item, part, items, dirty);
	}
	for (int i = 0; i < g_hBalStatic.Length; i++)
	{
		g_hBalStatic.GetString(i, item, sizeof(item));
		BalAppend(line, sizeof(line), item, part, items, dirty);
	}
	if (dirty) { EmitPug("%s", line); part++; }
	EmitPug("BALANCE_END half=%d parts=%d items=%d watch=%s", g_iHalf, part, items, g_bWatchFromFile ? "file" : "builtin");
}
