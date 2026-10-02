/**
 * A minimal obs-websocket v5 client (plan ruling 10): enough to connect to the
 * caster's own OBS at ws://localhost:4455, list scenes and switch the program
 * scene. The protocol is JSON over a WebSocket:
 *
 *   server -> Hello (op 0), with an auth challenge when a password is set
 *   client -> Identify (op 1), answering the challenge
 *   server -> Identified (op 2)
 *   client -> Request (op 6); server -> RequestResponse (op 7)
 *   server -> Event (op 5)
 *
 * The answer is base64(sha256(base64(sha256(password + salt)) + challenge)).
 * Browsers allow ws://localhost from an https page, so this runs on the site.
 */

export type ObsStatus = 'idle' | 'connecting' | 'connected' | 'failed';

export interface ObsClient {
  close(): void;
  sceneList(): Promise<string[]>;
  setProgramScene(name: string): Promise<void>;
  programScene(): Promise<string>;
}

async function sha256b64(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function obsAuth(password: string, salt: string, challenge: string): Promise<string> {
  return sha256b64((await sha256b64(password + salt)) + challenge);
}

interface Pending { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }

/** Connect and identify. Rejects with a message fit to show the producer. */
export function connectObs(o: {
  url: string;
  password: string;
  onProgramScene?: (name: string) => void;
  onClose?: () => void;
  timeoutMs?: number;
}): Promise<ObsClient> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(o.url);
    } catch {
      reject(new Error('That address is not a WebSocket URL.'));
      return;
    }
    const pending = new Map<string, Pending>();
    let seq = 0;
    let identified = false;
    const timer = setTimeout(() => {
      if (!identified) { ws.close(); reject(new Error('OBS did not answer. Is OBS open with Tools > WebSocket Server Settings > Enable on?')); }
    }, o.timeoutMs ?? 6000);

    const request = (requestType: string, requestData?: object): Promise<Record<string, unknown>> => new Promise((res, rej) => {
      const requestId = `r${++seq}`;
      pending.set(requestId, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });

    const client: ObsClient = {
      close: () => ws.close(),
      sceneList: async () => {
        const r = await request('GetSceneList');
        const scenes = (r.scenes ?? []) as { sceneName: string; sceneIndex: number }[];
        // OBS lists the bottom scene first.
        return scenes.slice().sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName);
      },
      setProgramScene: async (name) => { await request('SetCurrentProgramScene', { sceneName: name }); },
      programScene: async () => String((await request('GetCurrentProgramScene')).currentProgramSceneName ?? ''),
    };

    ws.onmessage = async (e) => {
      let msg: { op: number; d: Record<string, unknown> };
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      if (msg.op === 0) {
        const auth = msg.d.authentication as { challenge: string; salt: string } | undefined;
        const d: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: 1 << 2 };
        if (auth) {
          if (!o.password) { clearTimeout(timer); ws.close(); reject(new Error('OBS wants a password. Copy it from Tools > WebSocket Server Settings.')); return; }
          d.authentication = await obsAuth(o.password, auth.salt, auth.challenge);
        }
        ws.send(JSON.stringify({ op: 1, d }));
      } else if (msg.op === 2) {
        identified = true;
        clearTimeout(timer);
        resolve(client);
      } else if (msg.op === 7) {
        const id = String(msg.d.requestId);
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        const status = msg.d.requestStatus as { result: boolean; comment?: string } | undefined;
        if (status?.result) p.resolve((msg.d.responseData ?? {}) as Record<string, unknown>);
        else p.reject(new Error(status?.comment ?? 'OBS refused that.'));
      } else if (msg.op === 5) {
        if (msg.d.eventType === 'CurrentProgramSceneChanged') {
          o.onProgramScene?.(String((msg.d.eventData as { sceneName?: string } | undefined)?.sceneName ?? ''));
        }
      }
    };
    ws.onclose = (e) => {
      clearTimeout(timer);
      for (const p of pending.values()) p.reject(new Error('OBS closed the connection.'));
      pending.clear();
      if (!identified) {
        reject(new Error(e.code === 4009 ? 'OBS says the password is wrong.' : 'Could not reach OBS. Is OBS open with the WebSocket server enabled?'));
      } else {
        o.onClose?.();
      }
    };
  });
}
