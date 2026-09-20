import { useState } from 'preact/hooks';
import { api, ApiError, type Profile } from '../api';
import { WEB_PLATFORMS } from '../socialPlatforms';
import { COUNTRY_OPTIONS } from '../countries';

/** Where a backend-only route must be reached by a full navigation. preact-iso
 *  intercepts same-origin clicks unless target is set, the same reason
 *  DiscordLinkCard does this. */
const BACKEND = { target: '_top', rel: 'noopener' } as const;

/** Mirrors BIO_MAX_CHARS / BIO_MAX_LINES in src/profileFields.ts. The server
 *  is still the thing that enforces them; these only drive the counter and the
 *  textarea's own maxlength, so you find out before you press Save. */
const BIO_MAX = 200;
const BIO_MAX_LINES = 6;

/** What the server will count after it normalises: blank-line runs collapse,
 *  and leading and trailing blank lines go. Counting the raw value instead
 *  would tell the player they are over when they are not. */
function countLines(s: string): number {
  const normalised = s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalised === '' ? 0 : normalised.split('\n').length;
}

/**
 * The player's own profile fields, as a panel on their own profile rather than
 * a /settings route. Six fields do not earn a page, and moving them later is
 * small.
 *
 * The form sends every field it shows on each save, so a cleared input clears
 * the stored value. It never sends a field it does not show.
 */
export function ProfileEdit(
  { data, twitchEnabled, twitchLinked, onSaved }: {
    data: Profile;
    twitchEnabled: boolean;
    twitchLinked: boolean;
    onSaved: () => void;
  },
) {
  const [open, setOpen] = useState(false);
  const [bio, setBio] = useState(data.player.bio ?? '');
  const [pronouns, setPronouns] = useState(data.player.pronouns ?? '');
  const [country, setCountry] = useState(data.player.country ?? '');
  const [links, setLinks] = useState<Record<string, string>>(() => {
    // Defaulted for the same reason SocialChips defaults: during a deploy a
    // freshly loaded bundle can briefly talk to the previous server, and a
    // profile that throws is worse than one that opens with empty handles.
    const saved = data.social ?? [];
    const out: Record<string, string> = {};
    for (const p of WEB_PLATFORMS) {
      out[p.key] = saved.find((s) => s.platform === p.key)?.handle ?? '';
    }
    return out;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bioLines = countLines(bio);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveProfile({ bio, pronouns, country, links });
      setOpen(false);
      onSaved();
    } catch (err) {
      // The server's message names the field and says why, so show that rather
      // than a generic failure the player cannot act on.
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const unlinkTwitch = async () => {
    setBusy(true);
    try {
      await api.unlinkTwitch();
      onSaved();
    } catch {
      setError('Could not disconnect Twitch.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div class="profileedit">
        <button class="btn btn--ghost" onClick={() => setOpen(true)}>Edit profile</button>
      </div>
    );
  }

  return (
    <div class="profileedit profileedit--open">
      <label class="field">
        <span class="field__label">Bio</span>
        <textarea
          class="field__input field__input--area"
          rows={4}
          maxLength={BIO_MAX}
          value={bio}
          placeholder={`A few lines about you. ${BIO_MAX} characters, no links.`}
          onInput={(e) => setBio((e.target as HTMLTextAreaElement).value)}
        />
        <span class={`field__hint${bioLines > BIO_MAX_LINES ? ' field__hint--over' : ''}`}>
          {bio.length}/{BIO_MAX} · {bioLines}/{BIO_MAX_LINES} lines
        </span>
      </label>

      <label class="field">
        <span class="field__label">Pronouns</span>
        <input
          class="field__input"
          type="text"
          maxLength={24}
          value={pronouns}
          placeholder="they/them"
          onInput={(e) => setPronouns((e.target as HTMLInputElement).value)}
        />
      </label>

      <label class="field">
        <span class="field__label">Country</span>
        <select
          class="field__input"
          value={country}
          onChange={(e) => setCountry((e.target as HTMLSelectElement).value)}
        >
          <option value="">Not set</option>
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c.code} value={c.code}>{c.flag} {c.name}</option>
          ))}
        </select>
      </label>

      {WEB_PLATFORMS.map((p) => (
        <label class="field" key={p.key}>
          <span class="field__label">{p.label}</span>
          <input
            class="field__input"
            type="text"
            value={links[p.key] ?? ''}
            placeholder={p.placeholder}
            onInput={(e) => setLinks({ ...links, [p.key]: (e.target as HTMLInputElement).value })}
          />
        </label>
      ))}

      {twitchEnabled && (
        <div class="field">
          <span class="field__label">Twitch</span>
          {twitchLinked ? (
            <span class="field__static">
              {data.player.twitchName}
              <button class="btn btn--ghost" onClick={unlinkTwitch} disabled={busy}>
                Disconnect
              </button>
            </span>
          ) : (
            <span class="field__static">
              <a class="btn" href="/auth/twitch" {...BACKEND}>Connect Twitch</a>
              <span class="muted">Linking puts you on the Streams page.</span>
            </span>
          )}
        </div>
      )}

      {error && <p class="field__error">{error}</p>}

      <div class="profileedit__actions">
        <button class="btn" onClick={save} disabled={busy}>Save</button>
        <button class="btn btn--ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}
