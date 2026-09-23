import { useState } from 'preact/hooks';
import { api, ApiError } from '../api';
import { useFetch } from '../hooks/useFetch';
import { Panel } from './bits';
import { fmtDate } from '../format';

/**
 * What you have reported, and whether the ticket is still open. Nothing about
 * the outcome: that stays with the moderators. This is also the fallback for
 * people whose Discord DMs are closed, who never get the closing message, and
 * the site's way into a chat with the moderators about an open report.
 */
export function MyReports() {
  const { data } = useFetch((s) => api.myReports(s), []);
  const [chat, setChat] = useState<Record<number, { url?: string; error?: string }>>({});
  if (!data || data.reports.length === 0) return null;
  const openChat = async (id: number) => {
    try {
      const r = await api.reportChat(id);
      setChat((c) => ({ ...c, [id]: { url: r.url } }));
    } catch (err) {
      setChat((c) => ({ ...c, [id]: { error: err instanceof ApiError ? err.message : 'Something went wrong.' } }));
    }
  };
  return (
    <Panel>
      <h3>Your reports</h3>
      <ul class="admin-list">
        {data.reports.map((r) => (
          <li key={r.id}>
            {r.targetId
              ? <a href={`/player/${r.targetId}`}>{r.targetName ?? r.targetId}</a>
              : <>{r.targetName ?? 'a Discord member'}</>} · {r.category}
            {r.matchId !== null && <> · <a href={`/match/${r.matchId}`}>#{r.matchId}</a></>}
            {' '}· {fmtDate(r.createdAt)} · <span class="muted">{r.status === 'open' ? 'open' : 'closed, thank you'}</span>
            {r.status === 'open' && (chat[r.id]?.url
              ? <> · <a href={chat[r.id].url} target="_blank" rel="noreferrer">Open the chat in Discord</a></>
              : <> · <button class="chip" type="button" onClick={() => void openChat(r.id)}>Chat with the moderators</button></>)}
            {chat[r.id]?.error && <span class="error"> {chat[r.id].error}</span>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
