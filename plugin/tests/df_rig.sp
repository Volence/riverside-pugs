// Rig-only helper for the data feeds test (never shipped).
#pragma semicolon 1
#pragma newdecls required
#include <sourcemod>
#include <sdktools>
#include <sdkhooks>
#include <left4dhooks>

public void OnPluginStart()
{
	RegServerCmd("df_spawn", Cmd_Spawn, "df_spawn <class> - z_spawn via a survivor bot");
	RegServerCmd("df_hurt", Cmd_Hurt, "df_hurt <victim> <attacker|0> <dmg> <dmgtype> - SDKHooks_TakeDamage");
	RegServerCmd("df_ghostmat", Cmd_GhostMat, "df_ghostmat <client> - set m_isGhost then L4D_MaterializeFromGhost");
	RegServerCmd("df_who", Cmd_Who, "list clients");
	HookEvent("player_spawn", Ev, EventHookMode_Post);
	HookEvent("ghost_spawn_time", Ev, EventHookMode_Post);
	HookEvent("player_incapacitated_start", EvIncap, EventHookMode_Post);
	HookEvent("player_death", EvDeath, EventHookMode_Post);
}

public void L4D_OnMaterializeFromGhost(int client) { PrintToServer("[dfrig] forward MaterializeFromGhost %d", client); }
public void L4D_OnEnterGhostState(int client) { PrintToServer("[dfrig] forward EnterGhostState %d", client); }

public void Ev(Event e, const char[] name, bool db)
{
	int c = GetClientOfUserId(e.GetInt("userid"));
	PrintToServer("[dfrig] %s client=%d ghost=%d team=%d spawntime=%d", name, c,
		(c > 0 && IsClientInGame(c) && HasEntProp(c, Prop_Send, "m_isGhost")) ? GetEntProp(c, Prop_Send, "m_isGhost") : -1,
		(c > 0 && IsClientInGame(c)) ? GetClientTeam(c) : -1, e.GetInt("spawntime"));
}

public void EvIncap(Event e, const char[] name, bool db)
{
	char w[32]; e.GetString("weapon", w, sizeof(w));
	PrintToServer("[dfrig] incap_start victim=%d attacker=%d entid=%d weapon=%s type=%d", GetClientOfUserId(e.GetInt("userid")), GetClientOfUserId(e.GetInt("attacker")), e.GetInt("attackerentid"), w, e.GetInt("type"));
}

public void EvDeath(Event e, const char[] name, bool db)
{
	char w[32]; e.GetString("weapon", w, sizeof(w));
	int v = GetClientOfUserId(e.GetInt("userid"));
	PrintToServer("[dfrig] death victim=%d attacker=%d entid=%d weapon=%s type=%d", v, GetClientOfUserId(e.GetInt("attacker")), e.GetInt("attackerentid"), w, e.GetInt("type"));
}

public Action Cmd_Who(int args)
{
	for (int c = 1; c <= MaxClients; c++)
		if (IsClientInGame(c)) PrintToServer("[dfrig] %d %N team=%d alive=%d zc=%d hp=%d incap=%d", c, c, GetClientTeam(c), IsPlayerAlive(c),
			GetClientTeam(c) == 3 ? GetEntProp(c, Prop_Send, "m_zombieClass") : 0, GetClientHealth(c), GetEntProp(c, Prop_Send, "m_isIncapacitated"));
	return Plugin_Handled;
}

public Action Cmd_Spawn(int args)
{
	char cls[32]; GetCmdArg(1, cls, sizeof(cls));
	int bot = 0;
	for (int c = 1; c <= MaxClients && !bot; c++) if (IsClientInGame(c) && GetClientTeam(c) == 2) bot = c;
	if (!bot) { PrintToServer("[dfrig] no survivor"); return Plugin_Handled; }
	int flags = GetCommandFlags("z_spawn");
	SetCommandFlags("z_spawn", flags & ~FCVAR_CHEAT);
	FakeClientCommand(bot, "z_spawn %s auto", cls);
	SetCommandFlags("z_spawn", flags);
	PrintToServer("[dfrig] z_spawn %s via %d", cls, bot);
	return Plugin_Handled;
}

public Action Cmd_Hurt(int args)
{
	int v = GetCmdArgInt(1), a = GetCmdArgInt(2), d = GetCmdArgInt(3), t = GetCmdArgInt(4);
	if (a > 0) SDKHooks_TakeDamage(v, a, a, float(d), t);
	else SDKHooks_TakeDamage(v, 0, 0, float(d), t);
	PrintToServer("[dfrig] hurt %d by %d for %d type %d", v, a, d, t);
	return Plugin_Handled;
}

public Action Cmd_GhostMat(int args)
{
	int c = GetCmdArgInt(1);
	SetEntProp(c, Prop_Send, "m_isGhost", 1);
	PrintToServer("[dfrig] materialize %d -> %d", c, L4D_MaterializeFromGhost(c));
	return Plugin_Handled;
}
