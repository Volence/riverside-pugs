# Sub-project 7: Match Page Rebuild

## What this is

Piece 2 of the analytics work, narrowed. The match page becomes the place you find out
how a game went for you, by comparing you against the seven other people who played it.

Written 2026-09-11, after sub-project 6a shipped round-aware capture.

## The constraint that shaped everything

**The live database has one completed match.** Three aborted, five players, four rated.
The site went live the same day this was written.

That invalidates most of what "which games went badly for me" normally implies. You
cannot compare a game to your average when you have one game. Trends, percentiles and
benchmarks against the field are all noise at this N, and would be actively misleading
before roughly ten matches.

So the design has to be useful at N=1 and get better as matches accumulate, rather than
only working once a season of data exists. Everything below follows from that.

## Decisions

### The baseline is the other seven players in the same match

Decided 2026-09-11 against comparing to the player's own history.

In-match peer comparison needs no history, works from the first match, never degrades,
and is the comparison people actually argue about: not "was this below my average" but
"was I the weak link in this game". History-based comparison layers on later, as its own
piece, once there is enough of it to say anything.

This is what makes the MATCH page the diagnosis surface and leaves the player page as a
record that grows into usefulness.

### The player page is out of scope

`web/src/routes/Profile.tsx` is untouched. It already shows rating, lifetime totals,
recent matches and a by-map table. With one match, restructuring it into the
survivor/infected spine decided earlier would show one match's numbers split in two,
which is not an improvement on what is already there. Revisit when history exists.

### Do not normalize by time alive

In L4D1 versus a dead survivor stays dead until the round ends, so time alive varies a
lot. The instinct is to normalize it away as a distortion. That is backwards: dying early
IS the finding, not noise obscuring it. Same map, same rounds, so raw totals compare
fairly across all eight players.

**Time alive is not available anyway.** It is on no column of `match_players`, in no
field of the rcon dump, and in no key of `src/statKeys.ts`. It becomes derivable from
6a's timestamped `death` events once matches accumulate, but that is zero matches today.
Recorded here so nobody designs around it again.

### A table with marked outliers, not generated prose

Decided 2026-09-11 against a "what stood out" callout that names the problem in words.

A callout is the most direct answer to the question but it will sometimes present noise
as signal, and at this N most apparent signal IS noise. The table cannot say anything
stupid: it shows the numbers, marks the extremes, and the reader draws the conclusion.

### Stat direction belongs in the registry

The one piece of information the codebase lacks. `src/statKeys.ts` declares `side` and
`visibility` per key but nothing says whether high is good. High `skeets` is good, high
`ff_dealt` is bad, high `boomer_spawns` is neither, it is just how many boomers you drew.
Marking an outlier is impossible without knowing which end to praise.

So `StatDef` gains a third axis: `direction: 'high_good' | 'high_bad' | 'neutral'`.
Neutral columns are never marked. This follows the precedent of the `self` visibility
flag: a property of the stat, declared once in the registry, enforced everywhere, and
held in place by a parity test.

### Two guards on marking, both to stop it lying

1. **Trivial spread marks nobody.** Seven players on 2 clears and one on 3 is not an
   outlier. A column marks only when the gap is large enough relative to that column to
   mean something.
2. **An absent column marks nobody.** A server without skill_detect records no skeets,
   and crowning someone "worst" at a stat nobody measured is the fabricated-zero failure
   this codebase already refuses elsewhere.

### Headline cards split by side, and this needs no round data

A raw team total mixes "how good were you as survivors" with "how good were you as
infected", which are the two separate things that decide a versus match.

The split falls out of the registry's `side` field plus team membership, by the same
argument that let sub-project 6a cut its snapshot table: a survivor-side key can only
accrue while its owner is survivor. So the side-split works on matches recorded long
before round capture existed, including the one that already exists.

Cards: score, SI damage as survivors, damage as SI when infected, commons, friendly fire,
tank damage. Each A against B.

### Per-round section included, gated on availability

It shows "unavailable" for every match in the database today and lights up on the first
PUG played after 6a deploys. Included anyway because it is cheap: `roundAttribution` in
`src/roundStats.ts` already exists and `/api/matches/:id` already serves it. It is the
visible payoff of sub-project 6a.

## Scope

### In

- Outlier marking across all eight players, per column, direction-aware
- `direction` added to the stat registry, with a parity test
- A TEAM TOTAL row per team
- Side-split A-vs-B headline cards
- Per-round survivor/infected section, gated on availability
- Absent-not-zero handling throughout

### Non-goals

- **The player page.** Out of scope, see above.
- **Head-to-head compare.** Chosen earlier, cut here. It answers the same question the
  eight-row marked table now answers, less well.
- **Time alive.** No data source.
- **Generated callouts.** Decided against.
- **Any comparison against player history or the field.** Needs an N the database does
  not have.

## Error handling

| Case | Handling |
|---|---|
| skill_detect absent for the match | Columns render unavailable, excluded from marking |
| Round data absent | Round section renders unavailable, not empty and not zero |
| Round marked `reliable = 0` | Shown as unavailable, per 6a's rule |
| A column where every value is equal | No marking |
| A column where the spread is trivial | No marking |
| Fewer than 8 players (abandoned match) | Table renders what exists; marking still works on the players present |

## Testing

Putting direction in the registry makes the interesting logic pure, so it tests without a
DOM:

- **Outlier selection** as a function of (values, direction): highest marked good for
  `high_good`, lowest marked good for `high_bad`, nothing marked for `neutral`.
- **Both guards**: trivial spread marks nobody; a column of absent values marks nobody.
- **Registry parity**: every key in `STAT_DEFS` declares a direction. Same shape as the
  existing `tests/statKeysParity.test.ts`.
- **Side-split aggregation**: survivor-side keys sum into the survivor card for the team
  that owns them, infected-side into the other, with no round data present.
- **Absent-not-zero**: a match with `skillDetect: false` renders those columns as
  unavailable and they take part in no marking.

## Risks

**Marking invites over-reading.** Eight players on one map is a small sample, and being
worst at commons in one game means very little. The trivial-spread guard is the main
defence. If it proves too loud in practice, raise the threshold rather than adding
interpretation.

**`direction` is a judgement call per stat.** Most are obvious. `boomer_spawns` is
neutral because it is a denominator, not an achievement. `times_skeeted` is `high_bad`
but is already `self`-visibility, so it is never in a comparison anyone else sees. These
get decided once, in the registry, where they can be argued about.

## Still open

- Where the trivial-spread threshold should sit. Start with something conservative and
  tune once there are enough matches to see it behave.
