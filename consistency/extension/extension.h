#ifndef _INCLUDE_L4D_CONSISTENCY_EXTENSION_H_
#define _INCLUDE_L4D_CONSISTENCY_EXTENSION_H_

#include "smsdk_ext.h"

/**
 * One engine call, exposed to SourcePawn.
 *
 * L4D1's engine has the whole file-consistency mechanism: sv_consistency with a
 * real help string, CDownloadListGenerator::ForceExactFile, and the client half
 * in CClientState::ConsistencyCheck. What it does not have is anything that
 * turns it on. bin/server.so contains no reference to ForceExactFile, so the
 * game DLL asks for zero files to be checked, the enforced list is empty, and
 * sv_consistency 1 appears to do nothing. That is why the received wisdom is
 * that this is broken on L4D1. It is not broken; nothing populates the list.
 *
 * This extension is the missing piece and nothing more. It holds no state, hooks
 * nothing, and detours nothing. Which files get forced, and when, is a decision
 * that belongs in a plugin that can be reloaded without a rebuild.
 */
class ConsistencyExt : public SDKExtension
{
public:
	bool SDK_OnLoad(char *error, size_t maxlen, bool late) override;
	void SDK_OnUnload() override;
	bool SDK_OnMetamodLoad(ISmmAPI *ismm, char *error, size_t maxlen, bool late) override;
};

extern IVEngineServer *g_pEngine;

#endif // _INCLUDE_L4D_CONSISTENCY_EXTENSION_H_
