import { STATE, ZOMBIE_CLASSES, weaponName, type PlayerSample, type ReplayHeader } from '../../../src/replayFormat';
import { isSurvivor } from './draw';
import { healthBar, portraitFor, statusFlags } from './hud';

/** A tank carries 8000 health and everything else carries 100, so the bar
 *  needs to know which it is looking at or a tank's bar is permanently full.
 *  `cls` 5 is the tank in `m_zombieClass`. */
function maxHealthFor(p: PlayerSample): number {
  return !isSurvivor(p) && ZOMBIE_CLASSES[p.cls] === 'tank' ? 8000 : 100;
}

function Panel(
  { p, header, name, showHp, showGuns }:
  { p: PlayerSample; header: ReplayHeader; name: string; showHp: boolean; showGuns: boolean },
) {
  const present = (p.state & STATE.PRESENT) !== 0;
  const alive = (p.state & STATE.ALIVE) !== 0;
  const survivor = isSurvivor(p);
  const max = maxHealthFor(p);
  // The map's health ring reads the identical call. See `healthBar`: the two
  // surfaces used to compute their own answers and disagree about both
  // temporary health and the 300 point incapacitation pool.
  const bar = healthBar(p.health, p.temp, max, p.state);
  const flags = statusFlags(p.state);

  if (!present) return <div class="hudp hudp--empty" />;

  return (
    <div class={`hudp ${alive ? '' : 'hudp--dead'}`}>
      <img class="hudp__face" src={portraitFor(p.cls, header.version, survivor)} alt="" />
      <div class="hudp__body">
        <div class="hudp__top">
          <span class="hudp__name">{name}</span>
          {showHp && (
            <span class="hudp__hp" style={{ color: bar.color }}>
              {alive ? p.health : 0}
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
  { players, header, names, showHp, showGuns }:
  { players: PlayerSample[]; header: ReplayHeader; names: Record<string, string>; showHp: boolean; showGuns: boolean },
) {
  const survivors = players.filter(isSurvivor);
  const infected = players.filter((p) => !isSurvivor(p));

  const row = (group: PlayerSample[], label: string) => (
    <div class="hud-row">
      <span class="hud-row__label">{label}</span>
      {group.map((p) => (
        <Panel
          key={p.slot}
          p={p}
          header={header}
          // The header's slot roster is SteamID64 per slot. The name lookup
          // comes from the match page when there is one; a standalone session
          // has no roster to look names up in, so the id is the name.
          name={names[header.slots[p.slot]] ?? header.slots[p.slot] ?? `Slot ${p.slot}`}
          showHp={showHp}
          showGuns={showGuns}
        />
      ))}
    </div>
  );

  return (
    <div class="hud-strip">
      {row(survivors, 'Survivors')}
      {row(infected, 'Infected')}
    </div>
  );
}
