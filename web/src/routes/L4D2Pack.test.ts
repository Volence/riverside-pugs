import { describe, it, expect } from 'vitest';
import { pieceStatus, type L4D2Piece } from './L4D2Pack';

const piece = (over: Partial<L4D2Piece> = {}): L4D2Piece =>
  ({ id: 'c2', name: 'Dark Carnival', url: 'https://a/v1/dc.zip', bytes: 1, inAll: true, ...over });

describe('pieceStatus', () => {
  it('is null when nothing was downloaded', () => {
    expect(pieceStatus(piece(), {}, 'https://a/all.zip')).toBeNull();
  });
  it('is have for this exact piece, or for the full zip that holds it', () => {
    expect(pieceStatus(piece(), { c2: 'https://a/v1/dc.zip' }, 'https://a/all.zip')).toBe('have');
    expect(pieceStatus(piece(), { all: 'https://a/all.zip' }, 'https://a/all.zip')).toBe('have');
  });
  // A piece updated after the full zip was built: the player's copy is old.
  it('is updated when the downloaded version is not the current one', () => {
    expect(pieceStatus(piece({ url: 'https://a/v2/dc.zip' }), { c2: 'https://a/v1/dc.zip' }, 'https://a/all.zip')).toBe('updated');
    expect(pieceStatus(piece({ inAll: false }), { all: 'https://a/all.zip' }, 'https://a/all.zip')).toBe('updated');
    expect(pieceStatus(piece(), { all: 'https://a/old-all.zip' }, 'https://a/all.zip')).toBe('updated');
  });
});
