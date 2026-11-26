/**
 * 全局看板工作区徽标带该工作区强调色（框与页重设计）：
 * Worker 卡由工作区分组表达归属；调度入口由左栏未读回复气泡承载。
 */
import React from 'react';
import { render } from '@testing-library/react';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';

const cardBase = {
  sessionId: 's1',
  name: '卡',
  runtimeLabel: 'pi',
  status: 'idle' as const,
  relTimeTs: Date.now(),
  isActive: false,
  onSelect: () => {},
  onContextMenu: () => {}
};

describe('看板工作区徽标强调色', () => {
  it('Worker 卡：不重复显示工作区徽标', () => {
    const { container } = render(<BoardCard {...cardBase} />);
    expect(container.querySelector('.board-card-ws')).toBeNull();
  });
});
