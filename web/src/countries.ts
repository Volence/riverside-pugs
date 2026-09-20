/** The country picker's options, and the flag and name renderers.
 *
 *  Mirrors src/countries.ts, which is server code and is not importable from
 *  the bundle. The server validates against its own copy, so drift here can
 *  only ever offer an option the server then refuses; a test pins the two code
 *  lists together so that cannot happen quietly either. */
const CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS '
  + 'BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE '
  + 'EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM '
  + 'HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC '
  + 'LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA '
  + 'NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW '
  + 'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO '
  + 'TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

export const WEB_COUNTRY_CODES: readonly string[] = Object.freeze(CODES.split(' '));

let display: Intl.DisplayNames | null = null;
try {
  display = new Intl.DisplayNames(['en'], { type: 'region' });
} catch {
  display = null;
}

/** The flag emoji, which is just the code as two regional indicator symbols. */
export function countryFlag(code: string | null): string {
  if (!code) return '';
  const up = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return '';
  const base = 0x1f1e6 - 'A'.charCodeAt(0);
  return String.fromCodePoint(base + up.charCodeAt(0), base + up.charCodeAt(1));
}

export function countryName(code: string | null): string {
  if (!code) return '';
  const up = code.toUpperCase();
  try {
    return display?.of(up) ?? up;
  } catch {
    return up;
  }
}

export const COUNTRY_OPTIONS = WEB_COUNTRY_CODES
  .map((code) => ({ code, name: countryName(code), flag: countryFlag(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));
