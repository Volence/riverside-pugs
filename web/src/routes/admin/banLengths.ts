/** The ban lengths both ban forms offer: the ticket page's and the player
 *  file's. Staff asked (2026-11-03) for the steps between a day and a week,
 *  so a two- or four-day ban no longer has to round to 1 day or 7 days.
 *  null is Permanent. A moderator's cap filters this list on the ticket
 *  page; the server accepts any whole number of minutes either way. */
export const BAN_LENGTHS: [minutes: number | null, label: string][] = [
  [60, '1 hour'], [360, '6 hours'], [720, '12 hours'],
  [1440, '1 day'], [2880, '2 days'], [4320, '3 days'], [5760, '4 days'], [7200, '5 days'],
  [10080, '7 days'], [20160, '14 days'], [43200, '30 days'], [null, 'Permanent'],
];
