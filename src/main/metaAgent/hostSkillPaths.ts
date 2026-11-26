/**
 * 宿主技能路径的显式声明源（X7-F02 收口，APP_SKILL_PATH 同款机制）：
 * 非 run 工具域的技能若要随宿主域技能链接/安装链（hostDomainSkills /
 * hostSkillProvision）投递，必须在此显式声明其 SKILL.md 路径；hostDomainSkills
 * 只从声明派生域清单，禁止在派生处内联第二份路径字面量（单一真源合同）。
 */
import { SKILL_ROOT } from '../capabilities/catalog/runFactory';

/** 宿主记忆规约技能（memory 批引入；原硬编码于 hostDomainSkills 派生处，收口为正式声明） */
export const MEMORY_SKILL_PATH = `${SKILL_ROOT}/memory/SKILL.md`;
export const FEEDBACK_SKILL_PATH = `${SKILL_ROOT}/feedback/SKILL.md`;
export const DESKTOP_SKILL_PATH = `${SKILL_ROOT}/desktop/SKILL.md`;
export const PANEL_SKILL_PATH = `${SKILL_ROOT}/panel/SKILL.md`;
/** sessions 不是 run 域（手工 def），但 create 的配置面收归引用后必须有技能文档承载。 */
export const SESSIONS_SKILL_PATH = `${SKILL_ROOT}/sessions/SKILL.md`;
export const TURN_CHANGES_SKILL_PATH = `${SKILL_ROOT}/turn-changes/SKILL.md`;
export const CORE_CONTEXT_SKILL_PATH = `${SKILL_ROOT}/core-context/SKILL.md`;
/** Host authoring contracts are private resources, not project skill seeds. */
export const MUSTER_EXTENSIONS_SKILL_PATH = `${SKILL_ROOT}/muster-extensions/SKILL.md`;
export const UI_WIDGET_SKILL_PATH = `${SKILL_ROOT}/ui-widget-design/SKILL.md`;
