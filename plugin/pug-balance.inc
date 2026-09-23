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

ArrayList g_hBalStatic;      // "p:..=..", "f:..=..", "d:..=.." items, rebuilt each map
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
 *  and its bytes folded in, so a rename, an edit, an add or a delete all show. */
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
	char entry2[PLATFORM_MAX_PATH], full[PLATFORM_MAX_PATH];
	for (int i = 0; i < names.Length; i++)
	{
		names.GetString(i, entry2, sizeof(entry2));
		h = BalFoldString(h, entry2);
		h = BalFold(h, 0);
		Format(full, sizeof(full), "%s/%s", dir, entry2);
		BalFoldFile(full, h);
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

/** Map start: plugins, listed files and listed directories. */
void BalanceScanStatic()
{
	if (g_hBalStatic == null) g_hBalStatic = new ArrayList(ByteCountToCells(400));
	if (g_hBalCache == null) g_hBalCache = new StringMap();
	g_hBalStatic.Clear();
	float t0 = GetEngineTime();

	char name[PLATFORM_MAX_PATH], path[PLATFORM_MAX_PATH], value[64];
	Handle it = GetPluginIterator();
	while (MorePlugins(it))
	{
		Handle pl = ReadPlugin(it);
		if (GetPluginStatus(pl) != Plugin_Running) continue;
		GetPluginFilename(pl, name, sizeof(name));
		BuildPath(Path_SM, path, sizeof(path), "plugins/%s", name);
		if (BalFileValue(path, value, sizeof(value))) BalPush("p", name, value);
	}
	delete it;

	for (int i = 0; i < sizeof(g_sBalFiles); i++)
	{
		if (!BalFileValue(g_sBalFiles[i], value, sizeof(value))) strcopy(value, sizeof(value), "missing");
		BalPush("f", g_sBalFiles[i], value);
	}

	for (int i = 0; i < sizeof(g_sBalDirs); i++)
	{
		BalScanDir(g_sBalDirs[i], g_sBalDirExt[i], value, sizeof(value));
		BalPush("d", g_sBalDirs[i], value);
	}

	PugDebug("balance scan: %d items in %.1f ms", g_hBalStatic.Length, (GetEngineTime() - t0) * 1000.0);
}

/** Append one item, flushing the line first when it would pass BAL_LINE_MAX. */
static void BalAppend(char[] line, int maxlen, const char[] item, int &part, int &items, bool &dirty)
{
	if (dirty && strlen(line) + strlen(item) + 1 > BAL_LINE_MAX)
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

	for (int i = 0; i < sizeof(g_sBalCvars); i++)
	{
		ConVar cv = FindConVar(g_sBalCvars[i]);
		if (cv == null) Format(item, sizeof(item), "x:%s=missing", g_sBalCvars[i]);
		else
		{
			cv.GetString(val, sizeof(val));
			BalEncode(val, enc, sizeof(enc));
			Format(item, sizeof(item), "c:%s=%s", g_sBalCvars[i], enc);
		}
		BalAppend(line, sizeof(line), item, part, items, dirty);
	}
	for (int i = 0; i < g_hBalStatic.Length; i++)
	{
		g_hBalStatic.GetString(i, item, sizeof(item));
		BalAppend(line, sizeof(line), item, part, items, dirty);
	}
	if (dirty) { EmitPug("%s", line); part++; }
	EmitPug("BALANCE_END half=%d parts=%d items=%d", g_iHalf, part, items);
}
