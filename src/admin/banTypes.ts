/** BanRow on its own, so players.ts and banRedaction.ts can both import it
 *  without importing each other: banRedaction.ts redacts a BanRow that
 *  players.ts produces, and players.ts calls banRedaction.ts to do it. */
export interface BanRow {
  id: number;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  liftedBy: string | null;
  liftedAt: string | null;
  createdByName?: string | null;
  liftedByName?: string | null;
  /** 'alt_hold' for an alt hold (src/altHolds.ts), else 'ban'. */
  kind?: 'ban' | 'alt_hold';
}
