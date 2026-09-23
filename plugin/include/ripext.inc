// MODIFIED vendored copy of sm-ripext 1.3.2's pawn/scripting/include/ripext.inc.
// Upstream sha256 c56bf37fa29406fdcbcb1c4853372414fa1bd03154438dd1398c7d30a7fca895.
// The only change: the Extension entry at the bottom has autoload = 0 and
// required = 0 unconditionally, so the plugin never loads rip.ext by itself.
// ripext/http.inc and ripext/json.inc are unmodified (sha256
// b8781dff9aec7aa94b3d55300e976f38ee1171ed9079c462715cfc69f0147a05 and
// 8f0ba021a115a965aa03b0676b99b0417dda6a9a3355029b7576ef8a6fcb0559).

#if defined _ripext_included_
	#endinput
#endif
#define _ripext_included_

#include <ripext/json>
#include <ripext/http>

/**
 * Do not edit below this line!
 */
public Extension __ext_rip =
{
	name = "REST in Pawn",
	file = "rip.ext",
	// Riverside: never autoload, never require. Loading pug-match must not
	// load rip.ext on a live server; a server opts in by loading the
	// extension itself (see the top of plugin/pug-livepush.inc).
	autoload = 0,
	required = 0,
};
