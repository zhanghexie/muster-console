import { describe, expect, it } from 'vitest';
import { panelFilesCurrent } from '../../src/renderer/src/panelFileIdentity';

describe('center file identity', () => {
  const content = { kind: 'file' as const, path: 'a.txt', fileRef: { workspaceId: 'ws', rootId: 'root', relativePath: 'a.txt' } };
  const target = { kind: 'utility' as const, sel: 'center-file:right-7' };
  const state = { tabId: 'right-7', centerOnly: true, pinned: false, content };
  const binding = { sel: target.sel, tabId: state.tabId, centerOnly: true, pinned: false, content: JSON.stringify(content) };
  const read = (workspace: string) => workspace === 'ws' ? state : null;
  it('accepts only the exact current workspace, content, instance and ownership', () => {
    expect(panelFilesCurrent('ws', [target], [binding], read)).toBe(true);
    expect(panelFilesCurrent('other', [target], [binding], read)).toBe(false);
    expect(panelFilesCurrent('ws', [target], [{ ...binding, content: '{}' }], read)).toBe(false);
    expect(panelFilesCurrent('ws', [target], [{ ...binding, pinned: true }], read)).toBe(false);
    expect(panelFilesCurrent('ws', [target], [{ ...binding, centerOnly: false }], read)).toBe(false);
    expect(panelFilesCurrent('ws', [target], [{ ...binding, tabId: 'right-8' }], read)).toBe(false);
  });
  it('rejects missing, duplicate, extraneous and unavailable bindings', () => {
    expect(panelFilesCurrent('ws', [target], undefined, read)).toBe(false);
    expect(panelFilesCurrent('ws', [target, target], [binding, binding], read)).toBe(false);
    expect(panelFilesCurrent('ws', [{ kind: 'empty' }], [binding], read)).toBe(false);
    expect(panelFilesCurrent('ws', [target], [binding], () => { throw new Error('unavailable'); })).toBe(false);
    expect(panelFilesCurrent('ws', [{ kind: 'empty' }], undefined, read)).toBe(true);
  });
});
