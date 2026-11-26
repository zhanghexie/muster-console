/** Projection for workbench UI history; never mutate the runtime's context. */
export function withoutDisplayThinking<T extends { role: string; parts?: Array<{ kind: string }>; thinking?: string; approval?: { anchorPartIndex?: number }; userQuestion?: { anchorPartIndex?: number }; displayItems?: Array<{ anchorPartIndex: number }> }>(messages: T[]): T[] {
  return messages.map(message => {
    if (message.role !== 'assistant') return message;
    const parts = message.parts;
    const anchor = <A extends { anchorPartIndex?: number }>(card: A | undefined): A | undefined => {
      if (!card || card.anchorPartIndex == null || !parts) return card;
      const index = Math.max(0, Math.min(parts.length, card.anchorPartIndex));
      return { ...card, anchorPartIndex: parts.slice(0, index).filter(part => part.kind !== 'thinking').length };
    };
    const { thinking: _thinking, ...rest } = message;
    return { ...rest, ...(parts ? { parts: parts.filter(part => part.kind !== 'thinking') } : {}),
      ...(message.approval ? { approval: anchor(message.approval) } : {}),
      ...(message.userQuestion ? { userQuestion: anchor(message.userQuestion) } : {}),
      ...(message.displayItems ? { displayItems: message.displayItems.map(item => anchor(item)!) } : {}) } as T;
  });
}
