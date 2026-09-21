/**
 * Test vectors for pug-hmac.inc, and the program that checks them.
 *
 * ONE table, read by both sides. tests/logAuthVectors.test.ts parses the two
 * tables below out of this file and holds node:crypto to them; this program
 * holds the SourcePawn implementation to them. If either side drifts, its half
 * fails. Do not edit a MAC by hand: regenerate it from node and let both run.
 *
 * It calls no SourceMod native, so it runs under spshell, the SourcePawn VM's
 * own test shell, with no game server anywhere. See plugin/test-logauth.sh.
 * It prints one line per vector and then "PASS n" or "FAIL n".
 *
 * String vectors hold no quote and no backslash, so the table can be read
 * with a regular expression. The sweep covers every SHA-1 padding edge (55,
 * 56, 63, 64 and their neighbours, once and twice round) with bytes that are
 * above 127 and bytes that are zero, which a C string would have mangled.
 */
#pragma semicolon 1
#pragma newdecls required

native void print(const char[] str);

#include "pug-hmac.inc"

// { key, message, HMAC-SHA1 as 40 hex }
static const char g_sVectors[][3][160] = {
	{ "Jefe", "what do ya want for nothing?", "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79" },
	{ "0123456789abcdef0123456789abcdef", "", "8a22708cf0dde70b0e75ead9575e659dce6a85b2" },
	{ "0123456789abcdef0123456789abcdef", "L4DL id=76561198030413993 cheat=3 banned=1 lseq=1790000000.42", "b23a2d1e67ccb58287396f240b9ea81c40605057" },
	{ "0123456789abcdef0123456789abcdef", "PUGNET steamid=76561198030413993 ip=203.0.113.7 cc=US lseq=1790000000.1", "fc916519a96ed4c58eb285b76eb3ad2178aadf5f" },
	{ "0123456789abcdef0123456789abcdef", "L4DC SIGNON_DROP steamid=76561198030413993 secs=14 forced=651 name=Zoë ✓ 名前 lseq=1790000000.2147483647", "838e4e8468ffcc31b5b8a6fd429e3eca4f2a70ad" },
	{ "ffffffffffffffffffffffffffffffff", "PUG 0123456789abcdef0123456789abcdef MATCH_END a=645 b=610 winner=a lseq=1790000000.7", "e9ae21dce58f93a30485621d80a81992dbf2154a" },
	{ "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk", "exactly one block of key", "ed5f7b99db69e5371226bca264d95330690a70cb" },
	{ "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk", "a key longer than a block is hashed first", "36fb5dfb0fdcedf72f042176c02c62e33fd4c878" },
};

// Message i is SweepLen[i] bytes long and its byte j is (j * 7 + 3) & 0xFF.
// The key is always "0123456789abcdef0123456789abcdef".
static const int g_iSweepLen[] = { 0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 127, 128, 129, 500, 975 };
static const char g_sSweepMac[][41] = {
	"8a22708cf0dde70b0e75ead9575e659dce6a85b2",
	"2ee4068bb3c8be276f964cf66f7c974479b68fc6",
	"44a0c76f8d59fed4879ef0576b2abb9115aa90bb",
	"3edb8ae2811644df938d29ce63946c7e1aa9c470",
	"0dccbd32635240320983f9fc15165e166b4bb312",
	"ceeecef4142cb040ec1c1d424389a76b70d82bdb",
	"87d4adc473d2c1c06d3de54a760f1daa0f321bda",
	"d4ce5d2dadd829654c7c97c82b212512b8fcb00a",
	"18c1488abe8d6691da0f6472419d17267bda9342",
	"1b22881d5ff3f0a5e022e1baf117aec90140e5e5",
	"d5950aa79d7b8caed2390b43290db0deaf0943ee",
	"74cce384030eb8cb40521dc5d766f4b4d3ca743e",
	"92905b63f439182204232332a059c7b02594f86b",
	"ebf2d73401e0eef185cc927e1b649b3a5fc5376f",
	"d3b8edf6cfc8d92c14637e05f9017fa7cbfc63c5",
	"a2b77aa855e76ee2ac4477b14516c890a0b3daf4",
	"48ca2b28c7e6dfac0042a6cf075ed4d1f1e3ace5",
};

static int g_iFailed;
static int g_iRan;

static void Check(const char[] label, PugHmac hm, const char[] msg, int len, const char[] expect)
{
	char got[41];
	hm.Hex(msg, len, 20, got);
	char short8[9];
	hm.Hex(msg, len, 4, short8);
	bool ok = true;
	for (int i = 0; i < 40; i++) if (got[i] != expect[i]) ok = false;
	for (int i = 0; i < 8; i++) if (short8[i] != expect[i]) ok = false;
	if (got[40] != '\0' || short8[8] != '\0') ok = false;
	g_iRan++;
	if (!ok) g_iFailed++;
	print(ok ? "ok   " : "FAIL ");
	print(label);
	print(" ");
	print(got);
	print("\n");
}

static int Len(const char[] s)
{
	int n = 0;
	while (s[n] != '\0') n++;
	return n;
}

static void PrintNum(int n)
{
	char buf[12];
	int i = 11;
	buf[i] = '\0';
	if (n == 0) buf[--i] = '0';
	while (n > 0) { buf[--i] = '0' + (n % 10); n /= 10; }
	print(buf[i]);
}

public void main()
{
	PugHmac hm;
	for (int v = 0; v < sizeof(g_sVectors); v++)
	{
		hm.SetKey(g_sVectors[v][0], Len(g_sVectors[v][0]));
		Check("vector", hm, g_sVectors[v][1], Len(g_sVectors[v][1]), g_sVectors[v][2]);
	}

	hm.SetKey("0123456789abcdef0123456789abcdef", 32);
	char msg[1024];
	for (int v = 0; v < sizeof(g_iSweepLen); v++)
	{
		for (int j = 0; j < g_iSweepLen[v]; j++) msg[j] = (j * 7 + 3) & 0xFF;
		Check("sweep ", hm, msg, g_iSweepLen[v], g_sSweepMac[v]);
	}

	print(g_iFailed == 0 ? "PASS " : "FAIL ");
	PrintNum(g_iFailed == 0 ? g_iRan : g_iFailed);
	print("\n");
}
