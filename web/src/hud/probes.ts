/**
 * The probe gates: one entry per in-game question whose answer decides
 * whether an editor control does anything in the real game.
 *
 * A control whose effect is still unproven ships hidden behind its gate. The
 * page reads the gate to show the control, validateDesign reads it to drop a
 * stored value for a closed gate (so a gate that flips back off clears them),
 * the build writes a gated key only while its gate is open, and the preview
 * draws the "code decides" default until then. The questions and the probe
 * shots that answer them are in section 4 of
 * docs/superpowers/specs/2026-09-24-hud-editor-phase2-design.md.
 *
 * Flipping a gate is a planned task of its own, never an edit hidden inside
 * another: it also updates the tests that pin the control as hidden. A
 * question the game answered NO is retired, not kept as a closed gate, so
 * this stays a list of open or passed questions: Q5 (the health cross keeps
 * a file colour) failed in B1 and its control is gone (slice 2.F G4), and
 * TS2 (the versus scores, 262 and N/A, keep a file fgcolor_override) failed
 * in TAB-1: they drew grey with a dark edge whatever the file said
 * (/home/volence/l4d/hud/probe-tab/RESULTS.md, tab1/runs/tab-survivor/tab-a.png),
 * so code colours them and no control is offered (tab screen spec section 7).
 *
 * The Tab screen gates (TS*) are docs/superpowers/specs/2026-09-25-hud-editor-tab-screen-design.md
 * section 5, answered in section 7; the shots are under /home/volence/l4d/hud/probe-tab/.
 *
 * A leaf: imports nothing.
 */

export type ProbeId = 'Q1' | 'Q2' | 'Q3' | 'Q8' | 'Q24' | 'K5' | 'C2' | 'Z3' | 'T1' | 'P2'
  | 'TS1' | 'TS3' | 'TS4' | 'TS5' | 'TS5b' | 'TS6' | 'TS7' | 'TS8';

export const PROBES: Readonly<Record<ProbeId, { passed: boolean; batch: string; question: string }>> = {
  Q1: { passed: true, batch: 'B1 (a), (c)', question: 'monochrome_color on a HealthPanel recolours the whole panel (fill, outline, number, cross, scratches) in every state' },
  Q2: { passed: true, batch: 'B1 (a)', question: 'LocalPlayer clips its children and does not paint its own image' },
  Q3: { passed: true, batch: 'B1 (a)', question: 'inset draws the fill inset inside an outline' },
  Q8: { passed: true, batch: 'B1 (b)', question: 'the crouch icon keeps a file drawColor and shows only while crouched' },
  // /home/volence/l4d/hud/probe-phase2-infected/RESULTS.md, B14: b14/crops/si-b-zoom.png and card-b.png (b), b14b-a (the Boomer).
  Q24: { passed: true, batch: 'B14 (b, and b14b-a)', question: 'monochrome_color on the SI Health and the card HealthPanel recolours the bar (fill and outline) only, not the number, name or icon' },
  // /home/volence/l4d/hud/probe-phase2-rest/RESULTS.md, V1: the editor's own build with the gate forced open drew
  // the notices at size 24 (v1/crops/v1a-k-b-notice.png, v1a-s-b-notice.png). R4's notice had never fired.
  K5: { passed: true, batch: 'V1a (k-b, s-b)', question: "recordlabel0's font sets the kill notice's text size" },
  // Same file, C2 and V1: the chat opens only on a key bound to messagemode (client.dll 0x100b49e0), never from
  // the console, and synthetic X keys were ignored (v1/shots-v1a, v1/shots-v1e); the closed chat draws no box.
  C2: { passed: false, batch: 'R4 (i), R1 (n), V1a (c2), V1e (c2)', question: "basechat.res HudChat bgcolor_override colours the open chat's box" },
  // Same file, V1: debug_zombie_panel 1 drew the Tank offer box with the title, text and box colours written
  // (v1/crops/v1b-tank-offer.png).
  Z3: { passed: true, batch: 'V1b (zp-tank1)', question: "zombiepanel.res TankTakeover's title, text, picture and box keys are honoured" },
  // Same file, V1: a human Tank with the survivors in the rescue closets drew the meter with every key written
  // (v1/crops/v1d-frustration-a.png, v1d-frustration-d.png; east_aligned against the stock control v1f-frustration-stock-d.png).
  T1: { passed: true, batch: 'V1d (t-a, t-d), V1f (t-d)', question: 'frustrationmeter.res keys (east_aligned, label colours, fonts, moves) are honoured' },
  // Same file, V2 and V3: with one client only your own voice is heard, and voice_loopback never puts it in the voice
  // list or on a teammate card (r1-g), so neither the teammate talking icon nor the list's rows were ever drawn.
  // Needs a second player talking. Holds the voice_player upload and the voice list row keys (plan decision 3).
  P2: { passed: false, batch: 'R1 (r1-g, one client)', question: "with a second player talking, the teammate card's voice_player cell draws an uploaded picture, and HudVoiceStatus item_tall, item_wide and item_spacing size the voice list rows" },
  // /home/volence/l4d/hud/probe-tab/RESULTS.md, TAB-1: "No Mercy, Versus Mode" drew red (tab1/runs/tab-survivor/tab-a.png).
  TS1: { passed: true, batch: 'TAB-1 (tab-survivor tab-a)', question: "scoreboard.res MissionTitle's fgcolor_override colours the Tab screen's title" },
  // Same file, TAB-1: every row bar red, at full, at 40 health and down (tab1/runs/tab-survivor/tab-a.png). TAB-2 (TL3)
  // took the key out and the bars coloured by health, green, orange, red (tab2/runs/tab-survivor/tab-a.png).
  TS3: { passed: true, batch: 'TAB-1 (tab-survivor tab-a), TAB-2 (tab-survivor tab-a)', question: "scoreboardsurvivor.res SurvivorStatsHealth's monochrome_color colours every row bar in every health state, and without it the bars colour by health" },
  // Same file, TAB-1: the stat box drew at 945, 202 px = (420 + 0, 20 + 70) x 2.25 (tab1/runs/tab-survivor/tab-a.png).
  TS4: { passed: true, batch: 'TAB-1 (tab-survivor tab-a)', question: "scoreboard.res CVersusModeScoreboard's xpos and PC ypos move the versus score panel" },
  // Same file, TAB-1: your infected row drew yellow (tab1/runs/tab-infected/tab-c.png, tab-d.png).
  TS5: { passed: true, batch: 'TAB-1 (tab-infected tab-c, tab-d)', question: "scoreboardinfectedplayer.res PlayerBackground_Selected's bgcolor_override colours your own infected row" },
  // Same file, TAB-1: the other infected rows were never on screen (the harness has one infected player), so their
  // colour waits for a second infected player (tab screen spec section 7, the TS5 split).
  TS5b: { passed: false, batch: 'TAB-1 (tab-infected tab-c, tab-d, one infected player)', question: "scoreboardinfectedplayer.res PlayerBackground's bgcolor_override colours the other infected players' rows" },
  // Same file, TAB-1: your infected name drew cyan (tab1/runs/tab-infected/tab-c.png, "Mal"). The survivor file's
  // SurvivorStatsName and SurvivorStatsNoAvatarName stayed white whatever it said (tab1/runs/tab-survivor/tab-a.png):
  // code colours those, so they have no control and are not part of this gate. No infected bot row was on screen,
  // so NoAvatarName rides on Name's answer: the same Label class in the same file.
  TS6: { passed: true, batch: 'TAB-1 (tab-infected tab-c, tab-d)', question: "scoreboardinfectedplayer.res Name's and NoAvatarName's fgcolor_override colour the infected rows' names" },
  // Same file: TAB-1 hid TeamEnemy, HealthLabel and PingImage (tab1/runs/tab-survivor/tab-a.png); TAB-3 the whole versus
  // panel, the title, the survivor names, PingLabel and the infected names (tab3/runs/tab-survivor/tab-a.png,
  // tab3/runs/tab-infected/tab-c.png). A hidden HealthLabel takes HealthAmount with it (pinned to it).
  TS7: { passed: true, batch: 'TAB-1 (tab-survivor tab-a), TAB-3 (tab-survivor tab-a, tab-infected tab-c)', question: 'a hard hide (visible 0, 0 x 0, auto_wide_tocontents 0) removes a Tab screen piece, and an element hide the whole versus panel' },
  // Same file, TAB-2: TeamYours drew 68 px lower with "ypos" "60" in its if_embedded block (tab2/runs/tab-survivor/tab-a.png).
  TS8: { passed: true, batch: 'TAB-2 (tab-survivor tab-a)', question: 'an if_embedded block takes a key the stock file does not put there (ypos on TeamYours)' },
};

/** Test overrides, read before PROBES. */
const forced = new Map<ProbeId, boolean>();

export function probe(id: ProbeId): boolean {
  return forced.get(id) ?? PROBES[id].passed;
}

/** Tests only: force a gate, or null to go back to PROBES. */
export function _setProbe(id: ProbeId, value: boolean | null): void {
  if (value === null) forced.delete(id); else forced.set(id, value);
}
