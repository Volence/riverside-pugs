#ifndef _INCLUDE_L4D_CONSISTENCY_CONFIG_H_
#define _INCLUDE_L4D_CONSISTENCY_CONFIG_H_

#define SMEXT_CONF_NAME			"L4D1 File Consistency"
#define SMEXT_CONF_DESCRIPTION	"Exposes IVEngineServer::ForceExactFile, which L4D1's game DLL never calls"
#define SMEXT_CONF_VERSION		"0.1.0"
#define SMEXT_CONF_AUTHOR		"Riverside"
#define SMEXT_CONF_URL			"https://riversidepug.com"
#define SMEXT_CONF_LOGTAG		"CONSIST"
#define SMEXT_CONF_LICENSE		"GPL"
#define SMEXT_CONF_DATESTRING	__DATE__

#define SMEXT_CONF_METAMOD

// Deliberately NOT enabling gameconf. This extension binds no signatures and
// reads no gamedata: ForceExactFile is a public virtual on IVEngineServer and
// the SDK's interface version matches the shipped engine exactly, so the vtable
// is correct by construction. A gamedata file would be a thing to maintain and
// re-verify after every game update for no benefit.

#define SMEXT_LINK(name) SDKExtension *g_pExtensionIface = name;

#endif // _INCLUDE_L4D_CONSISTENCY_CONFIG_H_
