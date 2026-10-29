// Firebase Cloud Messaging (the HTTP v1 API), used by send-push.
//
// Signs in with the Firebase service key - the FIREBASE_SERVICE_ACCOUNT
// function secret, the JSON file Firebase gives you (set it with
// scripts/set-firebase-key.sh) - and sends one message per phone. No SDK: a
// signed token is exchanged for an access token, kept until a few minutes
// before it expires, and each message is one POST.

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

/** The service key from the secret - the JSON file as it is, or base64 of it
    (what scripts/set-firebase-key.sh stores) - or null when it isn't set or
    isn't one. */
export function parseServiceAccount(raw: string | undefined | null): ServiceAccount | null {
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : new TextDecoder().decode(Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0)));
    const j = JSON.parse(text);
    if (typeof j?.project_id !== 'string' || typeof j?.client_email !== 'string' || typeof j?.private_key !== 'string') {
      return null;
    }
    return {
      project_id: j.project_id,
      client_email: j.client_email,
      private_key: j.private_key,
      token_uri: typeof j.token_uri === 'string' ? j.token_uri : 'https://oauth2.googleapis.com/token',
    };
  } catch {
    return null;
  }
}

/** One alert for one phone. */
export interface FcmMessage {
  token: string;
  title: string;
  body: string;
  /** Read by the app when the alert is tapped (all values must be strings). */
  data: Record<string, string>;
  /** Alerts with the same group replace each other on the phone. */
  group?: string;
  /** Android channel ('queue' or 'general', created by the app). */
  channelId: string;
  /** Wake the phone now (queue alerts and the arrival reminder). */
  urgent: boolean;
  /** Not delivered at all after this long (a late "You're next" is worse than none). */
  ttlSeconds: number;
}

export type SendOutcome =
  | { ok: true }
  | {
      ok: false;
      /** The phone is gone (app deleted, token replaced): forget it. */
      gone: boolean;
      status: number;
      code: string;
      message: string;
    };

export interface FcmOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Where messages are sent (a stand-in for Firebase in tests). */
  apiBase?: string;
  /** The status-bar icon and its colour on Android (android/app/src/main/res). */
  androidIcon?: string;
  androidColor?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (s: string) => b64url(new TextEncoder().encode(s));

async function importKey(pem: string): Promise<CryptoKey> {
  // A key pasted through a shell sometimes keeps its line breaks as "\n".
  const b64 = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

export class FcmClient {
  private readonly sa: ServiceAccount;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly apiBase: string;
  private readonly androidIcon: string;
  private readonly androidColor: string;
  private key: Promise<CryptoKey> | null = null;
  private access: { token: string; until: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(sa: ServiceAccount, opts: FcmOptions = {}) {
    this.sa = sa;
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.apiBase = opts.apiBase ?? 'https://fcm.googleapis.com';
    this.androidIcon = opts.androidIcon ?? 'ic_stat_sanjeevnios';
    this.androidColor = opts.androidColor ?? '#3B5BDB';
  }

  /** An access token, reused until five minutes before it expires. */
  private accessToken(fresh = false): Promise<string> {
    if (!fresh && this.access && this.now() < this.access.until) return Promise.resolve(this.access.token);
    if (!this.pending) {
      this.pending = this.signIn().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async signIn(): Promise<string> {
    this.key ??= importKey(this.sa.private_key);
    const iat = Math.floor(this.now() / 1000);
    const unsigned =
      b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) +
      '.' +
      b64urlText(JSON.stringify({ iss: this.sa.client_email, scope: SCOPE, aud: this.sa.token_uri, iat, exp: iat + 3600 }));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await this.key, new TextEncoder().encode(unsigned));
    const res = await this.fetchFn(this.sa.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${b64url(new Uint8Array(signature))}`,
      }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || typeof j?.access_token !== 'string') {
      throw new Error(`Firebase sign-in failed (${res.status}): ${j?.error_description ?? j?.error ?? 'no token'}`);
    }
    const seconds = Number(j.expires_in) || 3600;
    this.access = { token: j.access_token, until: this.now() + (seconds - 300) * 1000 };
    return j.access_token;
  }

  /** The request body Firebase expects for one message. */
  body(m: FcmMessage): Record<string, unknown> {
    return {
      message: {
        token: m.token,
        notification: { title: m.title, body: m.body },
        data: m.data,
        android: {
          priority: m.urgent ? 'HIGH' : 'NORMAL',
          ttl: `${m.ttlSeconds}s`,
          notification: {
            channel_id: m.channelId,
            icon: this.androidIcon,
            color: this.androidColor,
            ...(m.group ? { tag: m.group } : {}),
          },
        },
        apns: {
          headers: {
            'apns-priority': m.urgent ? '10' : '5',
            'apns-expiration': String(Math.floor(this.now() / 1000) + m.ttlSeconds),
            ...(m.group ? { 'apns-collapse-id': m.group } : {}),
          },
          payload: { aps: { sound: 'default', ...(m.group ? { 'thread-id': m.group } : {}) } },
        },
      },
    };
  }

  private async attempt(m: FcmMessage, freshToken: boolean): Promise<SendOutcome & { retry?: 'later' | 'now' }> {
    let res: Response;
    try {
      const token = await this.accessToken(freshToken);
      res = await this.fetchFn(`${this.apiBase}/v1/projects/${encodeURIComponent(this.sa.project_id)}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(this.body(m)),
      });
    } catch (err) {
      return { ok: false, gone: false, status: 0, code: 'NETWORK', message: String(err), retry: 'later' };
    }
    if (res.ok) {
      await res.body?.cancel();
      return { ok: true };
    }

    let code = '';
    let message = '';
    try {
      const j = await res.json();
      message = String(j?.error?.message ?? '');
      const detail = (j?.error?.details ?? []).find((d: { errorCode?: string }) => d?.errorCode);
      code = String(detail?.errorCode ?? j?.error?.status ?? '');
    } catch {
      // not JSON
    }
    const gone =
      code === 'UNREGISTERED' ||
      code === 'SENDER_ID_MISMATCH' ||
      (code === 'INVALID_ARGUMENT' && /registration token/i.test(message));
    const retry = res.status === 401 ? 'now' : res.status === 429 || res.status >= 500 ? 'later' : undefined;
    return { ok: false, gone, status: res.status, code, message, retry };
  }

  /** Sends one message; a temporary failure is tried once more, after a second. */
  async send(m: FcmMessage): Promise<SendOutcome> {
    const first = await this.attempt(m, false);
    if (first.ok || !first.retry) return strip(first);
    if (first.retry === 'later') await this.sleep(1000);
    return strip(await this.attempt(m, first.retry === 'now'));
  }
}

function strip(o: SendOutcome & { retry?: unknown }): SendOutcome {
  if (o.ok) return { ok: true };
  const { gone, status, code, message } = o;
  return { ok: false, gone, status, code, message };
}
