import type { DB } from './db.js';
import type { AddonsTransport } from './addonsTransport.js';
import { getCampaign, installsOf, setInstall } from './customCampaigns.js';

/**
 * Putting a campaign onto every server, and recording what actually happened.
 *
 * Per server, never all-or-nothing: one unreachable box must not keep a
 * campaign off the others, and the panel shows which server is behind. Every
 * call is a retry of whatever is not yet installed, so this is safe to run
 * again at any time.
 *
 * Nothing here is allowed to throw. An install failure is a row, never an
 * exception that reaches a request handler or a match.
 */

export interface InstallTarget { id: number; transport: AddonsTransport | null }

export async function installCampaign(
  db: DB, slug: string, opts: { sourcePath: string; servers: InstallTarget[] },
): Promise<void> {
  for (const server of opts.servers) {
    // Re-read every iteration, not once at entry: a 300 MB transfer to one
    // server can take minutes, and an admin can delete the campaign while
    // that transfer is in flight. custom_campaign_installs.slug is a real
    // foreign key, so once the row is gone, writing another install row for
    // it throws rather than silently doing nothing. If the campaign is gone,
    // there is nothing left to install; stop rather than let that throw
    // reach the caller.
    const campaign = getCampaign(db, slug);
    if (!campaign) return;
    try {
      setInstall(db, slug, server.id, 'pending');
      if (!server.transport) {
        setInstall(db, slug, server.id, 'failed', {
          error: 'server is not configured with an addons transport',
        });
        continue;
      }
      await server.transport.put(opts.sourcePath, campaign.vpk_filename);
      const landed = await server.transport.size(campaign.vpk_filename);
      if (landed !== campaign.size_bytes) {
        setInstall(db, slug, server.id, 'failed', {
          error: `size mismatch: ${landed ?? 'absent'} on the server, ${campaign.size_bytes} expected`,
        });
        continue;
      }
      setInstall(db, slug, server.id, 'installed', { sha256: campaign.sha256, error: null });
    } catch (err) {
      // A delete can land in the gap between the getCampaign check above and
      // any of the writes in this iteration (including the one about to
      // happen below), so check again before assuming there is still a row
      // to record a failure against.
      if (!getCampaign(db, slug)) return;
      try {
        setInstall(db, slug, server.id, 'failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // Deleted in the time it took to get here. Nothing left to record.
        return;
      }
    }
  }
}

export async function uninstallCampaign(
  db: DB, slug: string, opts: { servers: InstallTarget[] },
): Promise<void> {
  const campaign = getCampaign(db, slug);
  if (!campaign) return;
  for (const server of opts.servers) {
    if (!server.transport) continue;
    try {
      await server.transport.remove(campaign.vpk_filename);
    } catch {
      // A file we cannot delete is not a reason to keep the row: the admin
      // asked for this campaign to go away, and a stale VPK on a box is inert.
    }
  }
  db.prepare('DELETE FROM custom_campaign_installs WHERE slug = ?').run(slug);
}

/** Whether every server named has this campaign. The pool gate, and the
 *  orchestrator's re-check at match start. */
export function isInstalledEverywhere(db: DB, slug: string, serverIds: number[]): boolean {
  const installed = new Set(
    installsOf(db, slug).filter((r) => r.state === 'installed').map((r) => r.server_id),
  );
  return serverIds.every((id) => installed.has(id));
}
