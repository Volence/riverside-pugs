/**
 * HMAC-SHA1 in plain SourcePawn, for pug-logauth.inc.
 *
 * SourceMod has no keyed hash, and no hash at all over a buffer in memory. This
 * is the textbook construction (FIPS 180-4 for SHA-1, RFC 2104 for HMAC) and
 * nothing home-made: the backend computes the same thing with node:crypto, and
 * tests/logAuthVectors.test.ts holds both sides to one table of vectors, which
 * plugin/tests/logauth_vectors.sp checks in a real SourcePawn VM.
 *
 * No natives are called anywhere in this file, on purpose: that is what lets
 * the vector harness run under spshell, outside a game server.
 *
 * SHA-1 is broken for collisions, which HMAC does not depend on; HMAC-SHA1 is
 * still a sound MAC. It is used here over SHA-256 because it is half the
 * rounds on a path that runs on the game thread for every log line.
 *
 * Cells are 32-bit and wrap on overflow, which is exactly the arithmetic SHA-1
 * is defined in. `>>>` is the logical shift; `>>` would drag the sign bit in.
 * Every byte read out of a char[] is masked, because a char above 127 must not
 * arrive sign-extended.
 */

#if defined _pug_hmac_included
 #endinput
#endif
#define _pug_hmac_included

static void PugSha1_Compress(int h[5], const int blk[64])
{
	int w[80];
	for (int i = 0; i < 16; i++)
	{
		w[i] = (blk[i * 4] << 24) | (blk[i * 4 + 1] << 16) | (blk[i * 4 + 2] << 8) | blk[i * 4 + 3];
	}
	for (int i = 16; i < 80; i++)
	{
		int x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
		w[i] = (x << 1) | (x >>> 31);
	}

	int a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
	for (int i = 0; i < 80; i++)
	{
		int f, k;
		if (i < 20)      { f = (b & c) | (~b & d);          k = 0x5A827999; }
		else if (i < 40) { f = b ^ c ^ d;                   k = 0x6ED9EBA1; }
		else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
		else             { f = b ^ c ^ d;                   k = 0xCA62C1D6; }
		int t = ((a << 5) | (a >>> 27)) + f + e + k + w[i];
		e = d;
		d = c;
		c = (b << 30) | (b >>> 2);
		b = a;
		a = t;
	}
	h[0] += a;
	h[1] += b;
	h[2] += c;
	h[3] += d;
	h[4] += e;
}

enum struct PugSha1
{
	int h[5];
	int buf[64];
	int fill;
	int total;

	void Init()
	{
		this.h[0] = 0x67452301;
		this.h[1] = 0xEFCDAB89;
		this.h[2] = 0x98BADCFE;
		this.h[3] = 0x10325476;
		this.h[4] = 0xC3D2E1F0;
		this.fill = 0;
		this.total = 0;
	}

	/** Carry on from a state saved after whole blocks: how the two HMAC pads
	 *  are hashed once per key instead of once per line. */
	void Resume(const int state[5], int bytesSoFar)
	{
		for (int i = 0; i < 5; i++) this.h[i] = state[i];
		this.fill = 0;
		this.total = bytesSoFar;
	}

	void Byte(int b)
	{
		this.buf[this.fill++] = b & 0xFF;
		this.total++;
		if (this.fill == 64)
		{
			PugSha1_Compress(this.h, this.buf);
			this.fill = 0;
		}
	}

	void Chars(const char[] data, int len)
	{
		for (int i = 0; i < len; i++) this.Byte(data[i]);
	}

	void Final(int digest[20])
	{
		// The length that is hashed is the message's, so it is taken before
		// the padding moves `total`.
		int bits_hi = this.total >>> 29;
		int bits_lo = this.total << 3;
		this.Byte(0x80);
		while (this.fill != 56) this.Byte(0);
		for (int s = 24; s >= 0; s -= 8) this.Byte(bits_hi >>> s);
		for (int s = 24; s >= 0; s -= 8) this.Byte(bits_lo >>> s);
		for (int i = 0; i < 5; i++)
		{
			for (int j = 0; j < 4; j++) digest[i * 4 + j] = (this.h[i] >>> (24 - j * 8)) & 0xFF;
		}
	}
}

/** One key, prepared once: the SHA-1 state after each of the two padded key
 *  blocks. Every MAC afterwards costs the message plus two short blocks. */
enum struct PugHmac
{
	int inner[5];
	int outer[5];
	bool keyed;

	void SetKey(const char[] key, int len)
	{
		int k[64];
		if (len > 64)
		{
			// RFC 2104: a key longer than a block is replaced by its hash.
			PugSha1 kh;
			kh.Init();
			kh.Chars(key, len);
			int kd[20];
			kh.Final(kd);
			for (int i = 0; i < 20; i++) k[i] = kd[i];
		}
		else
		{
			for (int i = 0; i < len; i++) k[i] = key[i] & 0xFF;
		}

		PugSha1 pad;
		pad.Init();
		for (int i = 0; i < 64; i++) pad.Byte(k[i] ^ 0x36);
		for (int i = 0; i < 5; i++) this.inner[i] = pad.h[i];
		pad.Init();
		for (int i = 0; i < 64; i++) pad.Byte(k[i] ^ 0x5C);
		for (int i = 0; i < 5; i++) this.outer[i] = pad.h[i];
		this.keyed = true;
	}

	void Clear()
	{
		this.keyed = false;
	}

	void Digest(const char[] msg, int len, int mac[20])
	{
		PugSha1 s;
		s.Resume(this.inner, 64);
		s.Chars(msg, len);
		int innerDigest[20];
		s.Final(innerDigest);
		s.Resume(this.outer, 64);
		for (int i = 0; i < 20; i++) s.Byte(innerDigest[i]);
		s.Final(mac);
	}

	/** The first `bytes` bytes of the MAC as lowercase hex. `out` needs
	 *  2 * bytes + 1 cells. */
	void Hex(const char[] msg, int len, int bytes, char[] out)
	{
		static const char digits[] = "0123456789abcdef";
		int mac[20];
		this.Digest(msg, len, mac);
		for (int i = 0; i < bytes; i++)
		{
			out[i * 2] = digits[mac[i] >> 4];
			out[i * 2 + 1] = digits[mac[i] & 0xF];
		}
		out[bytes * 2] = '\0';
	}
}
