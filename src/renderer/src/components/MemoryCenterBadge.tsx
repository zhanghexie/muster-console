/** Retained import compatibility for the retired-format viewer. No approval polling. */
export function usePendingApprovalCount(): number { return 0; }

/** Automatic memory processing is system progress, never a user approval badge. */
export function MemoryCenterBadge(): null { return null; }
