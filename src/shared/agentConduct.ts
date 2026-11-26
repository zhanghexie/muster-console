/**
 * 全局行为规约（Agent Rules）：用户在设置 → 能力参考里维护的规则，注入到所有 agent 面
 * （调度提示、GUI Worker 首条输入和传统 CLI 简报）。
 * 本模块是唯一渲染出口；零依赖（test/*.mjs 即时转译导入）。
 * 规则正文是用户数据（不进 i18n、不翻译）；这里只负责结构化与拼节。
 */

export interface AgentRule {
  /** 稳定 id（React key / 更新定位用） */
  id: string;
  text: string;
  enabled: boolean;
}
/** 首启/字段缺失时的种子规则：问题及时上报（普通条目，用户可改可删可停用） */
export const SEED_AGENT_RULES: AgentRule[] = [
  {
    id: 'report-anomalies',
    enabled: true,
    text: [
      '异常上报：执行中发现异常或疑点时，必须在对话中及时告知用户，不得静默绕过、自作主张换方案或假成功。典型情形：',
      '1) 引用的文件/技能/规约不存在、已失效，或内容与文档/任务描述矛盾；',
      '2) 现实行为与文档约定不符（如面板/工具解析失败、接口返回异常）；',
      '3) 任务无法完成（测试/构建失败、权限被拒、依赖缺失）。',
      '分级：做不下去或需要用户决策 → 说清卡点并停下等用户（Worker 报 needs_you）；仅需知晓 → 在对话里说明；重要异常可用 ui.notify。'
    ].join('\n')
  }
];

/** config 归一：非数组回退种子；逐条清洗（空文本丢弃、enabled 缺省 true、id 缺省按序补） */
export function normalizeAgentRules(raw: unknown): AgentRule[] {
  if (!Array.isArray(raw)) return SEED_AGENT_RULES.map((r) => ({ ...r }));
  const out: AgentRule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<AgentRule>;
    let text = typeof r.text === 'string' ? r.text.trim() : '';
    if (r.id === 'report-anomalies') {
      const obsolete = '3) 需要删除或修改其他组件依赖的契约文件（skills、宿主协议、被解析的文档格式）——先说明影响，等用户确认；';
      const lines = text.split('\n');
      const index = lines.indexOf(obsolete);
      if (index !== -1) {
        lines.splice(index, 1);
        if (lines[index] === '4) 任务无法完成（测试/构建失败、权限被拒、依赖缺失）。') {
          lines[index] = '3) 任务无法完成（测试/构建失败、权限被拒、依赖缺失）。';
        }
        text = lines.join('\n').trim();
      }
    }
    if (!text) continue;
    out.push({
      id: typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `rule-${out.length + 1}`,
      text,
      enabled: r.enabled !== false
    });
  }
  return out;
}

/** 已启用规则的正文列表（trim 过；通常 1-3 条） */
export function enabledRuleTexts(rules: AgentRule[] | undefined | null): string[] {
  return (rules ?? []).filter((r) => r.enabled && r.text.trim()).map((r) => r.text.trim());
}

/**
 * 调度提示、GUI Worker 首条消息和传统 CLI 简报 使用的完整小节。
 * 无启用规则返回空串（各面整体不出现该节）。
 */
export function renderAgentRulesSection(rules: AgentRule[] | undefined | null): string {
  const texts = enabledRuleTexts(rules);
  if (!texts.length) return '';
  return `## Global Conduct Rules (user-set; must be followed)\n${texts
    .map((text, i) => `${i + 1}. ${text}`)
    .join('\n')}`;
}
