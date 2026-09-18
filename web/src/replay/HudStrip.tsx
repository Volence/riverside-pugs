import { STATE, ZOMBIE_CLASSES, weaponName, type PlayerSample, type ReplayHeader } from '../../../src/replayFormat';
import { isSurvivor, maxHealthOf, slotColor, slotLabel, slotNumber } from './draw';
import { healthBar, portraitFor, statusFlags, TEMP_HEALTH_COLOR } from './hud';

function Panel(
  { p, header, name, showHp, showGuns }:
  { p: PlayerSample; header: ReplayHeader; name: string; showHp: boolean; showGuns: boolean },
) {
  const present = (p.state & STATE.PRESENT) !== 0;
  const alive = (p.state & STATE.ALIVE) !== 0;
  const survivor = isSurvivor(p);
  const max = maxHealthOf(p);
  // The map's health ring reads the identical call. See `healthBar`: the two
  // surfaces used to compute their own answers and disagree about both
  // temporary health and the 300 point incapacitation pool.
  const bar = healthBar(p.health, p.temp, max, p.state);
  const flags = statusFlags(p.state);

  if (!present) return <div class="hudp hudp--empty" />;

  return (
    <div
      class={`hudp ${alive ? '' : 'hudp--dead'}`}
      // The same palette the map draws, on the panel's left edge, so a dot on
      // the map can be matched to a panel without reading anything.
      style={{ borderLeftColor: slotColor(p.slot) }}
    >
      <img class="hudp__face" src={portraitFor(p.cls, header.version, survivor)} alt="" />
      <div class="hudp__body">
        <div class="hudp__top">
          {/* The number the map draws inside the dot. Map, panel and follow
              button are then three views of one slot rather than three
              things a viewer has to correlate by colour alone. */}
          <span class="hudp__slot" style={{ color: slotColor(p.slot) }}>{slotNumber(p.slot)}</span>
          <span class="hudp__name">{name}</span>
          {showHp && (
            <span class="hudp__hp" style={{ color: bar.color }}>
              {alive ? p.health : 0}
              {/* Permanent health alone is misleading: a survivor on 1
                  permanent and 90 temporary read as "1", one hit from death,
                  when they are nothing of the sort. Coloured to match the
                  bar's temp segment so the two read as one thing. Suppressed
                  while downed, where `healthBar` zeroes temp on purpose and
                  the number is a bleed-out reading rather than health. */}
              {alive && !bar.downed && p.temp > 0 && (
                <span class="hudp__hp-temp" style={{ color: TEMP_HEALTH_COLOR }}>
                  +{Math.round(p.temp)}
                </span>
              )}
            </span>
          )}
        </div>
        {!survivor && ZOMBIE_CLASSES[p.cls] && (
          <span class="hudp__cls">{ZOMBIE_CLASSES[p.cls]}</span>
        )}
        {showGuns && survivor && weaponName(p.weapon) && (
          <span class="hudp__gun">{weaponName(p.weapon)} {p.clip}/{p.reserve}</span>
        )}
        {flags.length > 0 && <span class="hudp__flags">{flags.join(' ')}</span>}
        <div class="hudp__bar">
          {/* Temporary health is drawn behind permanent health, so the
              permanent segment always starts at the left edge and the temp
              segment extends past it. That is how the game draws it. */}
          <div class="hudp__bar-temp" style={{ width: `${(bar.perm + bar.temp) * 100}%` }} />
          <div class="hudp__bar-perm" style={{ width: `${bar.perm * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

export function HudStrip(
  { players, header, names, showHp, showGuns, layout = 'strip' }: {
    players: PlayerSample[]; header: ReplayHeader; names: Record<string, string>;
    showHp: boolean; showGuns: boolean;
    /** `strip`: two labelled rows under the stage. `edges`: survivors down
     *  the left, infected down the right, as plates over the map (theater,
     *  spec 7.1). Same panels either way. */
    layout?: 'strip' | 'edges';
  },
) {
  const survivors = players.filter(isSurvivor);
  const infected = players.filter((p) => !isSurvivor(p));

  const panels = (group: PlayerSample[]) => group.map((p) => (
    <Panel
      key={p.slot}
      p={p}
      header={header}
      // The header's slot roster is SteamID64 per slot. The name lookup
      // comes from the match page when there is one; a standalone session
      // has no roster to look names up in, so the id is the name.
      // Finding 12's rule, here too: a standalone session has no roster,
      // and the seventeen-digit id is a worse answer than the slot's own
      // short label.
      name={names[header.slots[p.slot]] || slotLabel(p.slot)}
      showHp={showHp}
      showGuns={showGuns}
    />
  ));

  if (layout === 'edges') {
    return (
      <>
        <div class="hud-edge hud-edge--l">{panels(survivors)}</div>
        <div class="hud-edge hud-edge--r">{panels(infected)}</div>
      </>
    );
  }

  const row = (group: PlayerSample[], label: string) => (
    <div class="hud-row">
      <span class="hud-row__label">{label}</span>
      {panels(group)}
    </div>
  );

  return (
    <div class="hud-strip">
      {row(survivors, 'Survivors')}
      {row(infected, 'Infected')}
    </div>
  );
}
