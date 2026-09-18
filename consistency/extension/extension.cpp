#include "extension.h"
#include "eiface.h"

ConsistencyExt g_ConsistencyExt;
SMEXT_LINK(&g_ConsistencyExt);

IVEngineServer *g_pEngine = NULL;

/**
 * native int ForceExactFile(const char[] path)
 *
 * Marks one path for consistency checking. Returns 1 when the call was made,
 * 0 when it was refused, so the plugin can count and log what actually took.
 *
 * Refuses an empty path rather than passing it through: the engine stores what
 * it is given, and an empty entry in the downloadables string table is a way to
 * break every client's consistency check at once with no visible cause.
 *
 * Deliberately does NOT verify the file exists. The engine's own rule is that
 * this is called after precache, and asking the filesystem here would disagree
 * with the engine's search paths (VPKs, the dlc directories, addons) in ways
 * that would silently drop paths that are perfectly valid to the engine. The
 * plugin does the existence checking, against the game's file system, where the
 * answer means something.
 */
static cell_t Native_ForceExactFile(IPluginContext *pContext, const cell_t *params)
{
	char *path = NULL;
	pContext->LocalToString(params[1], &path);
	if (path == NULL || path[0] == '\0') {
		return 0;
	}
	if (g_pEngine == NULL) {
		return pContext->ThrowNativeError("engine interface is not available");
	}

	g_pEngine->ForceExactFile(path);
	return 1;
}

static const sp_nativeinfo_t g_Natives[] = {
	{ "ForceExactFile", Native_ForceExactFile },
	{ NULL, NULL },
};

bool ConsistencyExt::SDK_OnLoad(char *error, size_t maxlen, bool late)
{
	sharesys->AddNatives(myself, g_Natives);
	sharesys->RegisterLibrary(myself, "l4d_consistency");
	return true;
}

void ConsistencyExt::SDK_OnUnload()
{
}

bool ConsistencyExt::SDK_OnMetamodLoad(ISmmAPI *ismm, char *error, size_t maxlen, bool late)
{
	// GET_V_IFACE_CURRENT asks for INTERFACEVERSION_VENGINESERVER, which the
	// L4D1 SDK defines as "VEngineServer022". `strings bin/engine.so` yields
	// exactly and only VEngineServer022, so this either binds the interface
	// whose vtable the SDK header describes, or it fails loudly at load. There
	// is no path where it binds a DIFFERENT layout and calls the wrong virtual,
	// which is the failure a signature scan would have risked.
	GET_V_IFACE_CURRENT(GetEngineFactory, g_pEngine, IVEngineServer, INTERFACEVERSION_VENGINESERVER);
	return true;
}
