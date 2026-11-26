import React from 'react';
import { IconWrench } from './icons';

/** Three evenly spaced dots indicate that the assistant has not started yet. */
export function WaitingActivityIcon(): React.JSX.Element {
  return <span className="waiting-activity" aria-hidden="true">
    <svg viewBox="0 0 20 20" fill="currentColor" focusable="false">
      <circle className="waiting-activity-dot" cx="3.5" cy="10" r="1.8" />
      <circle className="waiting-activity-dot" cx="10" cy="10" r="1.8" />
      <circle className="waiting-activity-dot" cx="16.5" cy="10" r="1.8" />
    </svg>
  </span>;
}

/** Two outline sparkles share their geometry between live and retained thinking. */
export function ThinkingActivityIcon({ active }: { active: boolean }): React.JSX.Element {
  return <span className={`thinking-orbit${active ? ' is-active' : ' is-history'}`} aria-hidden="true">
    <svg viewBox="0 0 20 20" fill="none" focusable="false">
      <path className="thinking-spark-main" d="M8 2.5c.45 3.7 1.8 5.05 5.5 5.5C9.8 8.45 8.45 9.8 8 13.5 7.55 9.8 6.2 8.45 2.5 8 6.2 7.55 7.55 6.2 8 2.5Z" />
      <path className="thinking-spark-small" d="M15 10.5c.22 1.8.7 2.28 2.5 2.5-1.8.22-2.28.7-2.5 2.5-.22-1.8-.7-2.28-2.5-2.5 1.8-.22 2.28-.7 2.5-2.5Z" />
    </svg>
  </span>;
}

/** Unframed terminal prompt and cursor, animated only during execution. */
export function TerminalActivityIcon({ active }: { active: boolean }): React.JSX.Element {
  return <span className={`tool-card-icon terminal-activity${active ? ' is-active' : ''}`} aria-hidden="true">
    <svg className="terminal-activity-glyph" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path className="terminal-activity-command" d="M3.5 4.7 9.1 9.5 3.5 14.3" />
      <path className="terminal-activity-cursor" d="M11.4 14.2h5.1" />
    </svg>
  </span>;
}

/** All non-command, non-writing tool calls use the same outlined wrench. */
export function ToolActivityIcon({ active }: { active: boolean }): React.JSX.Element {
  return <IconWrench size={18} className={`tool-card-icon wrench-activity${active ? ' tool-activity-icon' : ''}`} />;
}

/** File edits and writes use an outlined page with a moving pencil. */
export function WriteActivityIcon({ active }: { active: boolean }): React.JSX.Element {
  return <span className={`tool-card-icon write-activity${active ? ' is-active' : ''}`} aria-hidden="true">
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d="M9.5 17.3H3.3a.8.8 0 0 1-.8-.8V3.5a.8.8 0 0 1 .8-.8h8l3.6 3.6v2.4" />
      <path d="M11.3 2.7v3.6h3.6M5.1 8.3h5.7M5.1 10.8h5.7M5.1 13.3h3.3" />
      <path className="write-activity-pencil" d="m10.2 17.5.6-2.5 5-5a1.2 1.2 0 0 1 1.7 0l.6.6a1.2 1.2 0 0 1 0 1.7l-5 5-2.9.8ZM14.8 11l2.3 2.3" />
    </svg>
  </span>;
}

/** Three lines move toward one another during context compression. */
export function CompactionActivityIcon(): React.JSX.Element {
  return <span className="compaction-activity" aria-hidden="true">
    <span className="compaction-activity-top" />
    <span className="compaction-activity-middle" />
    <span className="compaction-activity-bottom" />
  </span>;
}
