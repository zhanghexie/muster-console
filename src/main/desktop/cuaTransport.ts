import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ManagedStdioTransport } from './managedStdioTransport';
import { desktopRuntime } from './runtime';

/** Deliberately narrow: the driver is never exposed as an unrestricted MCP server. */
export const CUA_TOOLS = ['list_apps', 'list_windows', 'get_window_state', 'click', 'set_value',
  'check_permissions', 'bring_to_front', 'launch_app', 'drag', 'scroll', 'press_key', 'hotkey', 'type_text'] as const;
export type CuaTool = typeof CUA_TOOLS[number];
export type CuaSetValueDelivery = 'mode-parameter' | 'background-only' | 'unavailable';

export interface CuaConnection {
  connect(signal?: AbortSignal): Promise<void>;
  call(name: CuaTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

type DriverClient = Pick<Client, 'connect' | 'callTool' | 'listTools' | 'close'>;
type DriverTransport = Transport;
type DriverFactory = (options: { command: string; env: Record<string, string> }) => { client: DriverClient; transport: DriverTransport };

const makeDriver: DriverFactory = ({ command, env }) => {
  const client = new Client({ name: 'muster-desktop', version: '1.0.0' });
  const transport = new ManagedStdioTransport(command, env);
  return { client, transport };
};

/** One private driver per host-owned runtime. The binary path is fixed by the host, not the model. */
export class CuaTransport implements CuaConnection {
  private readonly client: DriverClient;
  private readonly transport: DriverTransport;
  private state: 'new' | 'connecting' | 'connected' | 'closed' = 'new';
  private cleanup?: Promise<void>;

  constructor(binary: string, environment: NodeJS.ProcessEnv = process.env, factory: DriverFactory = makeDriver,
    options: { embedded?: boolean } = {}) {
    if (!path.isAbsolute(binary)) throw new Error('Cua driver path must be absolute');
    const env: Record<string, string> = {};
    // Only pass values needed by the desktop session and OS process loader.
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
      'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
      'AT_SPI_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'XDG_DATA_HOME', 'XDG_DATA_DIRS',
      'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES']) {
      const value = environment[key];
      if (typeof value === 'string') env[key] = value;
    }
    // The driver otherwise defaults to its own telemetry preference. A host
    // operation must not silently introduce a third-party telemetry channel.
    env.CUA_DRIVER_RS_TELEMETRY_ENABLED = '0';
    env.CUA_TELEMETRY_ENABLED = '0';
    if (options.embedded) env.CUA_DRIVER_EMBEDDED = '1';
    if (desktopRuntime('linux', env) === 'linux-wayland') env.CUA_DRIVER_RS_ENABLE_WAYLAND = '1';
    const { client, transport } = factory({ command: binary, env });
    this.client = client;
    this.transport = transport;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.state !== 'new') throw new Error('Cua driver cannot be connected twice');
    this.state = 'connecting';
    try {
      await this.client.connect(this.transport, { signal });
      if ((this.state as string) === 'closed') throw new Error('Cua driver was closed while connecting');
      this.state = 'connected';
    }
    catch (error) {
      this.state = 'closed';
      this.cleanup ??= this.transport.close();
      try { await this.cleanup; } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Cua connection failed and driver exit is unconfirmed'); }
      throw error;
    }
  }

  async call(name: CuaTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.state !== 'connected') throw new Error('Cua driver is not connected');
    if (!(CUA_TOOLS as readonly string[]).includes(name)) throw new Error('Unsupported Cua operation');
    signal?.throwIfAborted();
    try {
      const result = await this.client.callTool({ name, arguments: args }, undefined, { signal });
      if (this.state !== 'connected' || signal?.aborted) throw new Error('Cua request outcome is unknown after driver closure or interruption');
      return result;
    }
    catch (error) {
      // The driver may have executed a cancelled or disconnected request. Never reuse
      // its session after an uncertain transport outcome.
      this.state = 'closed';
      this.cleanup ??= this.closeBoth();
      try { await this.cleanup; } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Cua request failed and driver exit is unconfirmed'); }
      throw error;
    }
  }

  /** Check the actual tool schema before selecting the platform adapter. */
  async setValueDelivery(platform: NodeJS.Platform = process.platform, signal?: AbortSignal): Promise<CuaSetValueDelivery> {
    if (this.state !== 'connected') throw new Error('Cua driver is not connected');
    if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error('Unsupported Cua platform');
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 8; page++) {
      signal?.throwIfAborted();
      const result = await this.client.listTools(cursor ? { cursor } : undefined, { signal });
      if (this.state !== 'connected' || signal?.aborted) throw new Error('Cua tool listing was interrupted');
      if (!Array.isArray(result.tools) || result.tools.length > 500) throw new Error('Invalid Cua tool listing');
      const tool = result.tools.find(item => item.name === 'set_value');
      if (tool) {
        const mode = tool.inputSchema?.properties?.delivery_mode as { type?: unknown; enum?: unknown } | undefined;
        if (mode?.type === 'string' && Array.isArray(mode.enum) && mode.enum.includes('background') && mode.enum.includes('foreground')) return 'mode-parameter';
        // The macOS set_value tool uses background delivery with a strict
        // schema and no delivery_mode parameter.
        if (!mode && platform === 'darwin' && tool.inputSchema.additionalProperties === false) return 'background-only';
        return 'unavailable';
      }
      const next = result.nextCursor;
      if (typeof next !== 'string' || !next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return 'unavailable';
  }

  async close(): Promise<void> {
    this.state = 'closed';
    this.cleanup ??= this.closeBoth();
    await this.cleanup;
  }

  private async closeBoth(): Promise<void> {
    let clientError: unknown;
    try { await this.client.close(); } catch (error) { clientError = error; }
    // The MCP client clears its transport after an unexpected child exit, so
    // client.close() alone does not prove that the owned tree was reclaimed.
    try { await this.transport.close(); }
    catch (error) { throw clientError ? new AggregateError([clientError, error], 'Cua driver cleanup failed') : error; }
    if (clientError) throw clientError;
  }
}
