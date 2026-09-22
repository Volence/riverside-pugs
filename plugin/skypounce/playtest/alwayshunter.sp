/**
 * alwayshunter: playtest helper, NEVER for a live server. Turns every human
 * infected ghost into a hunter. L4D1's versus spawner picks a ghost's class by
 * its own rotation and ignores z_gas_limit / z_exploding_limit for players, so
 * the only reliable way to test hunter play alone is to set the class.
 */
#include <sourcemod>
#include <left4dhooks>

#pragma semicolon 1
#pragma newdecls required

#define TEAM_INFECTED 3
#define ZC_HUNTER 3

public Plugin myinfo = { name = "alwayshunter (playtest)", author = "Riverside", description = "human infected ghosts become hunters", version = "0", url = "" };

public void OnPluginStart()
{
	CreateTimer(0.5, Timer_Check, _, TIMER_REPEAT);
}

Action Timer_Check(Handle timer)
{
	for (int i = 1; i <= MaxClients; i++)
	{
		if (!IsClientInGame(i) || IsFakeClient(i) || GetClientTeam(i) != TEAM_INFECTED || !IsPlayerAlive(i)) continue;
		if (GetEntProp(i, Prop_Send, "m_isGhost") == 0) continue;
		if (GetEntProp(i, Prop_Send, "m_zombieClass") == ZC_HUNTER) continue;
		L4D_SetClass(i, ZC_HUNTER);
		PrintToChat(i, "[playtest] you are a hunter now");
	}
	return Plugin_Continue;
}
