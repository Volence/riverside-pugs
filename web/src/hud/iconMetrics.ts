// Item icon glyphs: how far each one advances the row, and the space the game puts
// between two, as a fraction of the font cell height the PNGs are drawn at.
export const ICON_ADVANCE: Record<string, number> = {
  'icon/item/medkit': 0.8076,
  'icon/item/molotov': 0.7544,
  'icon/item/pills': 0.4644,
  'icon/item/pipebomb': 0.7798,
};

export const ICON_SPACE = 0.2954;

/**
 * The item PNGs' cell and baseline as fractions of the em they were drawn at,
 * so the preview can size a glyph by the em the game draws, not by the tall.
 *
 * scripts/export-hud-art.py draws each glyph with FreeType at the smallest
 * size whose cell (hhea ascender plus descender, rounded to whole pixels)
 * reaches 64 px: that is 68 ppem, a 64 px cell with the baseline 49 px down
 * (PIL getmetrics (49, 15)). So a PNG drawn s px tall shows the glyph at
 * s / (64 / 68) ppem, and its baseline is 49 / 68 em below its top. (The
 * unrounded hhea ratios are 0.932 and 0.712; the PNGs carry the rounded
 * ones, and ICON_ADVANCE was measured against the same 64 px cell, so
 * 0.8076 x 64 / 68 = 0.760 em is hmtx's medkit advance exactly.)
 *
 * The game does not fit the glyph cell to the tall. Its Win32 font picks the
 * ppem from the face's VDMX table, GDI style (fonts.ts fontCell): at 1080p
 * L4D_Icons_medium is 18 x 2.25 = 40 px, which ToolBox's VDMX makes 34 ppem
 * (ascent 34, descent 5). Sizing the PNG cell to the tall instead drew the
 * glyphs 1.28x the game's and about 7 px high: probe p4 measured the game's
 * medkit, pills and pipe bomb 83 px wide and 23 px tall against the
 * preview's 106 and 30, the ink centre 7.5 px lower in game, and Louis's
 * card medkit about 25 px against 30
 * (/home/volence/l4d/hud/probe-your-items/RESULTS.md, p4).
 */
export const ICON_CELL_EM = 64 / 68;
export const ICON_ASCENT_EM = 49 / 68;

/**
 * The ToolBox face's em per unit of font tall with no hinting: head's
 * unitsPerEm over OS/2 winAscent + winDescent (1000 / (985 + 144), as
 * art/index.ts FONT_METRICS). The unit layout (youritems.ts) is resolution
 * independent, so it sizes the row by this upper bound: for the 18 tall the
 * game's VDMX ppem, back in units, is 15.0 at 768p, 15.1 at 1080p, 15.7 at
 * 1440p and 15.8 at 2160p against 15.94 here, so a Label this wide always
 * holds the row.
 */
export const ICON_EM_PER_TALL = 1000 / (985 + 144);
