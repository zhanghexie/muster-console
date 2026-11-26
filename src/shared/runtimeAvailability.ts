import type { AgentRuntimeEntry } from './types';
import type { RuntimePreflightResult } from './runtimePreflight';

/** Registered, enabled workers whose local dependency/configuration preflight passed. */
export interface RuntimeAvailabilitySnapshot {
  runtimes: AgentRuntimeEntry[];
  /** Display probes include disabled built-in GUI runtimes; runtimes remains the selectable list. */
  runtimePreflights?: Record<string, RuntimePreflightResult>;
  /** PATH-only program discovery for the existing CLI entries, independent of their enabled state. */
  cliPrograms?: Record<string, { status: 'found' | 'not_found' | 'unknown'; command: string }>;
  /** ACP has one worker registry entry and independently installed agent presets. */
  acpAgents: Array<{ id: string; name: string }>;
  /** Per-preset static probe results for settings. They do not attest login or inference. */
  acpPreflights?: Record<string, RuntimePreflightResult>;
  /** Resolved executable paths for successful ACP probes, when still present. */
  acpExecutables?: Record<string, string>;
  checkedAt: number;
}
