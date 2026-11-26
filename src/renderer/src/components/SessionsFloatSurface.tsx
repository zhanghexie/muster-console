import React, { forwardRef } from 'react';
import { usePresence } from './motion';

/** Keep the sidebar alive, but stop painting after its covering stage closes. */
export const SessionsFloatSurface = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & {
  open: boolean;
  hidden: boolean;
}>(function SessionsFloatSurface({ open, hidden, children, ...props }, ref) {
  const presence = usePresence(open);
  return <div {...props} ref={ref} {...presence.spread}
    className={`sessions-float${open ? ' is-open' : ''}${open || presence.mounted ? ' is-retained' : ''}${hidden ? ' is-hidden' : ''}`}>
    {children}
  </div>;
});
