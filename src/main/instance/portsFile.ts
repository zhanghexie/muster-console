import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export type InstancePortsFile = {
  instanceId: string;
  webAccessPort?: number;
  shellApiPort?: number;
  updatedAt: number;
};

export function instancePortsPath(userDataDir: string): string {
  return userDataStorage(userDataDir).file('instance-ports');
}

export function loadInstancePorts(userDataDir: string): InstancePortsFile | null {
  const file = instancePortsPath(userDataDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as InstancePortsFile;
    if (!raw?.instanceId) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveInstancePorts(userDataDir: string, patch: Partial<InstancePortsFile> & { instanceId: string }): InstancePortsFile {
  const file = instancePortsPath(userDataDir);
  const prev = loadInstancePorts(userDataDir);
  const next: InstancePortsFile = {
    instanceId: patch.instanceId || prev?.instanceId || randomUUID(),
    webAccessPort: patch.webAccessPort ?? prev?.webAccessPort,
    shellApiPort: patch.shellApiPort ?? prev?.shellApiPort,
    updatedAt: Date.now()
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function ensureInstanceId(userDataDir: string): string {
  const env = process.env.MUSTER_INSTANCE_ID?.trim();
  if (env) {
    saveInstancePorts(userDataDir, { instanceId: env });
    return env;
  }
  const prev = loadInstancePorts(userDataDir);
  if (prev?.instanceId) return prev.instanceId;
  const id = randomUUID();
  saveInstancePorts(userDataDir, { instanceId: id });
  return id;
}
