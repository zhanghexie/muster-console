import type { ComponentType, ReactNode } from 'react';

export type ChannelAccountCall = (
  channel: string, method: string, payload: unknown, signal?: AbortSignal
) => Promise<unknown>;

export function setChannelAccountLocale(language: string): void;
export function installChannelAccountStyles(): () => void;

export function ChannelAccountSettings(props: Readonly<{
  channel: string;
  call: ChannelAccountCall;
  disclosure: {
    openLabel: string;
    closeLabel: string;
    provisionConnectedLabel: string;
    Disclosure: ComponentType<{ id: string; open: boolean; children: ReactNode }>;
  };
}>): ReactNode;
