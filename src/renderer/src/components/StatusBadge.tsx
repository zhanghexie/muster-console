import React from 'react';

/** A shared status skin; callers retain ownership of labels and status derivation. */
export const StatusBadge = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement> & {
  label?: string;
  attention?: boolean;
}>(function StatusBadge({ label, attention = false, className, children, ...attributes }, ref) {
  const classes = [...new Set(['status-badge', 'session-capsule', ...(className?.split(/\s+/).filter(Boolean) ?? [])])].join(' ');
  return (
    <span {...attributes} ref={ref} className={classes} data-status-attention={attention ? 'true' : undefined}>
      {children ?? <span className="session-capsule-label">{label}</span>}
    </span>
  );
});
