import type { ReactNode } from 'react';
import { MOTION, usePresence } from '../motion';

export function ChannelDisclosure({ id, open, children }: {
  id: string; open: boolean; children: ReactNode;
}): React.JSX.Element {
  const presence = usePresence(open, MOTION.exitMs);
  return (
    <div id={id} ref={node => { node?.toggleAttribute('inert', !open); }} aria-hidden={!open || undefined}>
      {presence.mounted && (
        <div className={`acc muster-messaging-disclosure${open && presence.stage === 'in' ? ' is-open' : ''}`} {...presence.spread}>
          <div className="acc-body">{children}</div>
        </div>
      )}
    </div>
  );
}
