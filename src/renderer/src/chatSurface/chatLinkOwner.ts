import { createContext } from 'react';

/** Ownership of links and interactive cards rendered inside one page or conversation. */
export type ChatLinkOwner = { workspaceId?: string; sessionId?: string; scope?: 'workspace' | 'session' };
export const ChatLinkOwnerContext = createContext<ChatLinkOwner>({});
