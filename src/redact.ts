import { serverPasswordFor } from './matchToken.js';

/**
 * Take the secrets out of an error message before anyone but this process
 * reads it.
 *
 * Every rcon failure reports the command it was running: `RconClient.exec`
 * rejects with `rcon exec timeout: <cmd>`. Two of those commands ARE secrets.
 * `sm_pug_leave <token> ...` carries the match token, which is that live
 * match's sv_password (`serverPasswordFor`), and `sm_pug_log_secret "<x>"`
 * carries the value every log line is signed with. The message from a failed
 * action goes three places at once: the admin's browser, `admin_actions.detail`
 * and the Discord admin feed, and the last two outlive the incident by months.
 *
 * So the secret, and the password derived from it, become `<redacted>` in all
 * three. What is left still says which box and which command gave up, which is
 * the whole diagnostic value of the line.
 *
 * The host:port a raw connect error carries is deliberately NOT redacted.
 * Every admin already reads a server's host and port off the Servers panel,
 * the feed channel is admin-only, and `logAdmin` persists and publishes one
 * object, so blanking it for Discord would also blank it in the audit row and
 * leave the written record of an incident saying less than the screen the
 * admin read it on.
 */
export const REDACTED = '<redacted>';

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `message` with every occurrence of every secret, and of the sv_password a
 *  token derives, replaced. Blank and absent secrets are skipped, so a caller
 *  can pass a nullable column straight in. Case-insensitive, because a console
 *  echo is not required to give a value back in the case it was sent in. */
export function redactSecrets(message: string, secrets: readonly (string | null | undefined)[]): string {
  let out = message;
  for (const secret of secrets) {
    if (!secret) continue;
    for (const value of [secret, serverPasswordFor(secret)]) {
      out = out.replace(new RegExp(escapeRe(value), 'gi'), REDACTED);
    }
  }
  return out;
}
