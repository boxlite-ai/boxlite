import { UpstreamError, fail } from './errors.js';
import { requestJson } from './http.js';

export interface BoxInfo {
  id: string;
  name: string;
  status: string;
}

export interface CreateBoxRequest {
  name: string;
  image: string;
  cpus: number;
  memory_mib: number;
  disk_size_gb: number;
  env: Record<string, string>;
  cmd: string[];
  auto_stop: number;
  auto_resume: boolean;
  network: { inbound: { mode: 'enabled' | 'disabled' } };
  volumes?: { managed_volume: string; guest_path: string }[];
}

export interface VolumeInfo {
  id: string;
  name: string;
  /** When the API reports them (the console shows them). */
  sizeBytes?: number | null;
  state?: string | null;
}

type RawVolume = { volume_id?: string; id?: string; name?: string; size_bytes?: unknown; used_bytes?: unknown; size_gb?: unknown; state?: unknown; status?: unknown };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

/** The slice of the BoxLite /v1 REST API the CP uses. Injected so tests run against a fake. */
export interface BoxliteClient {
  createBox(req: CreateBoxRequest): Promise<BoxInfo>;
  getBox(idOrName: string): Promise<BoxInfo | null>;
  startBox(id: string): Promise<void>;
  stopBox(id: string): Promise<void>;
  deleteBox(id: string): Promise<void>;
  /** Registers the public tunnel for `port` and returns its URL. */
  tunnel(id: string, port: number): Promise<string>;
  createVolume(name: string): Promise<VolumeInfo>;
  listVolumes(): Promise<VolumeInfo[]>;
  deleteVolume(id: string): Promise<void>;
}

interface RawBox {
  box_id?: string;
  id?: string;
  name?: string;
  status?: string;
}

const toBox = (b: RawBox): BoxInfo => ({ id: String(b.box_id ?? b.id ?? ''), name: String(b.name ?? ''), status: String(b.status ?? 'unknown') });

export class HttpBoxliteClient implements BoxliteClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) throw fail('unavailable', 'BOXLITE_API_KEY is not configured on the control plane', 'the platform cannot create Boxes right now, and nothing in the app can change that: tell the user the platform operator must configure its BoxLite API key');
    const { body: out } = await requestJson<T>('boxlite', {
      method,
      url: `${this.baseUrl}${path}`,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body,
      timeoutMs: 60_000,
    });
    return out;
  }

  async createBox(req: CreateBoxRequest): Promise<BoxInfo> {
    return toBox(await this.call<RawBox>('POST', '/boxes', req));
  }

  async getBox(idOrName: string): Promise<BoxInfo | null> {
    try {
      return toBox(await this.call<RawBox>('GET', `/boxes/${encodeURIComponent(idOrName)}`));
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return null;
      throw err;
    }
  }

  async startBox(id: string): Promise<void> {
    await this.call('POST', `/boxes/${encodeURIComponent(id)}/start`);
  }

  async stopBox(id: string): Promise<void> {
    await this.call('POST', `/boxes/${encodeURIComponent(id)}/stop`);
  }

  async deleteBox(id: string): Promise<void> {
    try {
      await this.call('DELETE', `/boxes/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return;
      throw err;
    }
  }

  async tunnel(id: string, port: number): Promise<string> {
    const out = await this.call<{ uri?: string; url?: string }>('POST', `/boxes/${encodeURIComponent(id)}/network/tunnel?port=${port}`);
    const uri = out.uri ?? out.url;
    if (!uri) throw new UpstreamError('boxlite', 200, 'tunnel response carried no uri');
    return uri.replace(/\/+$/, '');
  }

  /** Volume routes answer 403 for keys without volume access; surface that as a clear `forbidden`. */
  private async volumeCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.call<T>(method, path, body);
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 403) {
        throw fail('forbidden', 'the platform API key is not allowed to manage BoxLite volumes (403 from /v1/volumes)', 'the platform cannot manage volumes yet: remove [[volume]] from boxlite.toml (keep files in the database), or tell the user the platform operator must grant its key volume permissions');
      }
      throw err;
    }
  }

  async createVolume(name: string): Promise<VolumeInfo> {
    const v = await this.volumeCall<{ volume_id?: string; id?: string; name?: string }>('POST', '/volumes', { name });
    return { id: String(v.volume_id ?? v.id ?? name), name: String(v.name ?? name) };
  }

  async listVolumes(): Promise<VolumeInfo[]> {
    const out = await this.volumeCall<{ volumes?: RawVolume[] } | RawVolume[]>('GET', '/volumes');
    const list = Array.isArray(out) ? out : (out.volumes ?? []);
    return list.map((v) => {
      const gb = num(v.size_gb);
      const state = v.state ?? v.status;
      return {
        id: String(v.volume_id ?? v.id ?? v.name),
        name: String(v.name ?? ''),
        sizeBytes: num(v.size_bytes) ?? num(v.used_bytes) ?? (gb !== null ? gb * 1024 ** 3 : null),
        state: typeof state === 'string' ? state : null,
      };
    });
  }

  async deleteVolume(id: string): Promise<void> {
    await this.volumeCall('DELETE', `/volumes/${encodeURIComponent(id)}`);
  }
}
