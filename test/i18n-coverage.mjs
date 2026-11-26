/**
 * i18n 双闸门：
 * ① 词条对账：源码里每个 t('…') 字面量 key 必须在词条表（locales/**.ts，含 fragments）有英文，缺失即 fail。
 * ② 日常裸中文检测：渲染层中未翻译的字面量及 JSX 文本/属性会失败。
 *    显式 --audit 扩展到主进程和共享层，其中包含模型协议与持久数据，需人工判定。
 * 运行: node test/i18n-coverage.mjs（npm test 自动带上）；全仓审计加 --audit。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { scanJsxChinese } from './helpers/i18n-jsx-scan.mjs';
import { findIdentifierReferences, maskConsoleCallsPreservingLines, maskCssCommentsPreservingLines, maskDisplayDataPreservingLines, maskKnownLiteralsPreservingLines, maskModelDiagnosticsPreservingLines, maskProtocolFunctionsPreservingLines, maskRegexLiteralsPreservingLines, maskTranslatedCallsPreservingLines, maskVerifiedLabelReferencesPreservingLines, maskVerifiedTemplatesPreservingLines, scanRawChineseLines, shouldScanRawChinese, stripCommentsPreservingLines } from './helpers/i18n-comments.mjs';
import { AUDIT_ACCEPTED_LINES } from './i18n-audit-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIRS = ['src'];
const auditHost = process.argv.includes('--audit');
const LOCALES_DIR = path.join(root, 'src', 'shared', 'i18n', 'locales');

// These tests enumerate the data-driven labels masked below. Running them as
// part of the gate prevents a missing key from being hidden on later changes.
await import('./capability-display-i18n.mjs');
await import('./memory-overview-i18n.mjs');
await import('./agent-app-builtins-i18n.mjs');
await import('./ui-dynamic-i18n.mjs');
await import('./ui-widget-runtime-i18n.mjs');
const { catalogRequestLabels } = await import('./gui-host-timeout-i18n.mjs');

const gateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-gate-src-'));
const gateCompile = createSharedCompiler(root, gateTmp);
// 核心抽取单源在 shared/dimensionGates.ts（R-14 机械门与本测试共用，勿再各写一份）
const { extractTCallKeyPositions, extractLocaleKeys, duplicateLocaleKeys } = await import(
  pathToFileURL(gateCompile('shared/dimensionGates.ts')).href
);
const { EXTENSION_REASON_KEYS, EXTENSION_REASON_TEMPLATES } = await import(
  pathToFileURL(gateCompile('shared/extensionReason.ts')).href
);
const { DEFAULT_BOOKMARKS } = await import(pathToFileURL(gateCompile('shared/defaultBookmarks.ts')).href);
const { SUBAGENT_CHARACTERS } = await import(pathToFileURL(gateCompile('shared/subagentCharacters.ts')).href);
const { WORKSPACE_ICONS } = await import(pathToFileURL(gateCompile('shared/workspaceIcons.ts')).href);
const { HOME_SEARCH_PRESETS } = await import(pathToFileURL(gateCompile('renderer/src/browserHomePreferences.ts')).href);
const { INJECTION_REGISTRY } = await import(pathToFileURL(gateCompile('main/agent/injection-registry.ts')).href);
const { TURN_CHANGE_TEXT_KEYS, TURN_CHANGE_TEXT_TEMPLATES } = await import(pathToFileURL(gateCompile('renderer/src/turnChangeDisplay.ts')).href);
const { KNOWLEDGE_UI_ERROR_KEYS, KNOWLEDGE_UI_ERROR_TEMPLATES } = await import(pathToFileURL(gateCompile('main/memory/knowledgeUserErrors.ts')).href);
const { SAFETY_REASON_KEYS, SAFETY_REASON_TEMPLATES, SAFETY_UI_ERROR_KEYS } = await import(pathToFileURL(gateCompile('shared/safetyReason.ts')).href);
const { APP_UI_ERROR_KEYS, APP_STATUS_ERROR_KEYS, APP_UI_ERROR_TEMPLATES } = await import(pathToFileURL(gateCompile('shared/appUserErrors.ts')).href);
const { APP_RECORD_PLACEHOLDERS } = await import(pathToFileURL(gateCompile('shared/appRecordPlaceholders.ts')).href);
const { APP_CONNECTION_NAME_PLACEHOLDERS } = await import(pathToFileURL(gateCompile('shared/appConnectionName.ts')).href);
const { MAILBOX_UI_ERROR_KEYS, MAILBOX_UI_ERROR_TEMPLATES } = await import(pathToFileURL(gateCompile('shared/mailboxUserErrors.ts')).href);
const { unknownRepoI18n } = await import(pathToFileURL(gateCompile('main/git/workspaceResolve.ts')).href);
const { KNOWLEDGE_DISPLAY_KEYS, KNOWLEDGE_DISPLAY_TEMPLATES } = await import(pathToFileURL(gateCompile('shared/knowledgeDisplayText.ts')).href);
const { GUI_HOST_ERROR_KEYS, GUI_HOST_ERROR_TEMPLATES, GUI_HOST_ERROR_FRAMES, GUI_HOST_ERROR_COMPOUNDS, GUI_HOST_ERROR_SUFFIXES, GUI_HOST_TIMEOUT_LABELS } = await import(pathToFileURL(gateCompile('shared/guiHostError.ts')).href);
const { CLI_LAUNCH_ERROR_KEYS, CLI_LAUNCH_ERROR_FRAMES } = await import(pathToFileURL(gateCompile('shared/cliLaunchError.ts')).href);
const { guiPermissionOptions } = await import(pathToFileURL(gateCompile('shared/guiPermissionOptions.ts')).href);
const { HARNESS_CATALOG } = await import(pathToFileURL(gateCompile('shared/harnessCatalog.ts')).href);
const { KNOWLEDGE_HISTORY_TRUNCATION_NOTE } = await import(pathToFileURL(gateCompile('shared/knowledge.ts')).href);
const { UI_WIDGET_HOST_ERROR_KEYS } = await import(pathToFileURL(gateCompile('shared/uiWidgetHostErrors.ts')).href);
const { SKILL_CONSOLIDATION_ERRORS, SKILL_CONSOLIDATION_PREFIXES } = await import(pathToFileURL(gateCompile('renderer/src/panels/skillConsolidationDisplay.ts')).href);
const { photoAlbumExample } = await import(pathToFileURL(gateCompile('shared/agentAppsExamples.ts')).href);
fs.rmSync(gateTmp, { recursive: true, force: true });

function walk(dir, out = [], extRe = /\.(tsx?|jsx)$/) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'out' || name === '.git') continue;
      walk(p, out, extRe);
    } else if (extRe.test(name)) {
      out.push(p);
    }
  }
  return out;
}

// ---------- ① 词条对账 ----------
const localeKeys = extractLocaleKeys(walk(LOCALES_DIR, [], /\.ts$/).map((f) => fs.readFileSync(f, 'utf8')));
const duplicates = duplicateLocaleKeys(localeKeys);
if (duplicates.length) console.error(`[i18n] 重复词条 ${duplicates.length} 个：${duplicates.join('、')}`);
const enKeys = new Set(localeKeys);
if (catalogRequestLabels.some(key => !enKeys.has(key))) throw new Error('Catalog request labels are missing English translations');
const appRecordPlaceholderSources = Object.values(APP_RECORD_PLACEHOLDERS).map(item => item.source);
const missingAppPlaceholders = appRecordPlaceholderSources.filter(key => !enKeys.has(key));
if (missingAppPlaceholders.length) throw new Error(`Imported record placeholders are missing English translations: ${missingAppPlaceholders.join(', ')}`);
const appConnectionNamePlaceholders = Object.values(APP_CONNECTION_NAME_PLACEHOLDERS);
const missingConnectionNames = appConnectionNamePlaceholders.map(item => item.key).filter(key => !enKeys.has(key));
if (missingConnectionNames.length) throw new Error(`Generated connection names are missing English translations: ${missingConnectionNames.join(', ')}`);
const mailboxErrorLiterals = [...MAILBOX_UI_ERROR_KEYS, ...MAILBOX_UI_ERROR_TEMPLATES.flatMap(item => [item.prefix, item.key])];
if ([...MAILBOX_UI_ERROR_KEYS, ...MAILBOX_UI_ERROR_TEMPLATES.map(item => item.key)].some(key => !enKeys.has(key))) throw new Error('Mailbox user errors are missing English translations');
const unusedRepoLabels = ['missing', 'unindexed'].map(reason => unknownRepoI18n({ reason, resolved: '', activeWorkspace: '', targetWorkspace: '' }).key);
if (unusedRepoLabels.some(key => !enKeys.has(key))) throw new Error('Unused repository diagnostics are missing English translations');
const historyDisplayLiterals = [KNOWLEDGE_HISTORY_TRUNCATION_NOTE, '调度原始会话', '已中止', '失败', '原始记录'];
if (historyDisplayLiterals.some(key => !enKeys.has(key))) throw new Error('Knowledge history labels are missing English translations');
const permissionLabels = new Set();
for (const [runtime, agent] of [[undefined, undefined], ['pi', undefined], ['pi-external', undefined], ['omp', undefined], ...HARNESS_CATALOG.map(item => [item.runtimeId, item.acpPresetId])]) {
  for (const current of [undefined, 'standard', 'accept-edits', 'auto-review', 'default', 'ask', 'plan', 'auto']) {
    for (const option of guiPermissionOptions(runtime, current, agent)) { permissionLabels.add(option.label); permissionLabels.add(option.description); }
  }
}
const missingPermissionLabels = [...permissionLabels].filter(label => /\p{Script=Han}/u.test(label) && !enKeys.has(label));
if (missingPermissionLabels.length) throw new Error(`GUI permission translations missing: ${missingPermissionLabels.join(', ')}`);
const allBookmarks = nodes => nodes.flatMap(node => [node, ...allBookmarks(node.children ?? [])]);
const missingBookmarkLabels = allBookmarks(DEFAULT_BOOKMARKS).filter(node => /[\u4e00-\u9fff]/.test(node.label) && !enKeys.has(node.label)).map(node => node.label);
if (missingBookmarkLabels.length) console.error(`[i18n] 默认收藏缺少英文词条：${missingBookmarkLabels.join('、')}`);
const missingOtherLabels = [...SUBAGENT_CHARACTERS.flatMap(role => [role.name, role.role]), ...WORKSPACE_ICONS.map(icon => icon.label), ...HOME_SEARCH_PRESETS.map(engine => engine.name)]
  .filter(label => /[\u4e00-\u9fff]/.test(label) && !enKeys.has(label));
if (missingOtherLabels.length) console.error(`[i18n] 内置角色、图标或搜索引擎缺少英文词条：${missingOtherLabels.join('、')}`);
const missingInjectionNotes = INJECTION_REGISTRY.filter(entry => !enKeys.has(entry.note)).map(entry => entry.id);
if (missingInjectionNotes.length) console.error(`[i18n] 注入清单缺少英文词条：${missingInjectionNotes.join('、')}`);
const missingTurnChangeText = [...TURN_CHANGE_TEXT_KEYS, ...TURN_CHANGE_TEXT_TEMPLATES.map(item => item.key)].filter(key => !enKeys.has(key));
if (missingTurnChangeText.length) console.error(`[i18n] 轮次改动诊断缺少英文词条：${missingTurnChangeText.join('、')}`);
const turnChangeLiterals = [...TURN_CHANGE_TEXT_KEYS, ...TURN_CHANGE_TEXT_TEMPLATES.flatMap(item => [item.prefix, item.key, ...(item.suffix ? [item.suffix] : [])])];
const missingKnowledgeErrors = [...KNOWLEDGE_UI_ERROR_KEYS, ...KNOWLEDGE_UI_ERROR_TEMPLATES.map(item => item.key)].filter(key => !enKeys.has(key));
if (missingKnowledgeErrors.length) console.error(`[i18n] 用户记忆操作缺少英文错误词条：${missingKnowledgeErrors.join('、')}`);
const knowledgeErrorLiterals = [...KNOWLEDGE_UI_ERROR_KEYS, ...KNOWLEDGE_UI_ERROR_TEMPLATES.flatMap(item => [item.prefix, item.key])];
const missingKnowledgeDisplay = [...KNOWLEDGE_DISPLAY_KEYS, ...KNOWLEDGE_DISPLAY_TEMPLATES.map(item => item.key)].filter(key => !enKeys.has(key));
if (missingKnowledgeDisplay.length) console.error(`[i18n] 记忆状态说明缺少英文词条：${missingKnowledgeDisplay.join('、')}`);
const knowledgeDisplayLiterals = [...KNOWLEDGE_DISPLAY_KEYS, ...KNOWLEDGE_DISPLAY_TEMPLATES.flatMap(item => [item.prefix, item.key]), '已被 ', '证据合并至 ', '保留差异（对照 ', '已核对差异（对照 ', '原始依据、适用内容和策略未变化：', '；沿用原候选，不重复复评'];
// These draft diagnostics originate in the curator's model contract; the same
// exact patterns are projected in the human-facing memory failure display.
const draftDiagnosticLiterals = [': 必须提供非空文本（最多1500字符）', ': 必须为', '非空', '文本，最多1500字符', ': 必须提供字符串数组', '（无已知例外时使用[]）', ': 必须为字符串数组，最多12项', ': 最多12项', ']: 必须为非空文本，最多300字符', ': 必须为文本，最多', '字符；实际写入范围仍由宿主绑定', '必须提供非空文本（最多1500字符）', '必须为非空文本，最多1500字符', '必须为文本，最多1500字符', '必须提供字符串数组', '必须提供字符串数组（无已知例外时使用[]）', '必须为字符串数组，最多12项', '最多12项', '必须为非空文本，最多300字符'];
const evidenceDiagnosticLiterals = [']: 记忆证据必须由宿主提供可追溯事件对象', ': 必须为', '非空', '宿主来源文本，最多1000字符', ': 必须为有限数值事件时间', ': 必须为宿主绑定的unverified/test/integration/runtime/user_stated/user_confirmed等级', ': 证据身份不能重复', ': 证据内容签名必须为64位小写十六进制哈希', ': 证据摘录必须为文本，最多4000字符', ': 宿主观察类型仅允许tool_output或user_input', '记忆证据必须由宿主提供可追溯事件对象', '必须为非空宿主来源文本，最多1000字符', '必须为宿主来源文本，最多1000字符', '必须为有限数值事件时间', '必须为宿主绑定的unverified/test/integration/runtime/user_stated/user_confirmed等级', '证据身份不能重复', '证据内容签名必须为64位小写十六进制哈希', '证据摘录必须为文本，最多4000字符', '宿主观察类型仅允许tool_output或user_input'];
const missingSafetyReasons = [...SAFETY_REASON_KEYS, ...SAFETY_UI_ERROR_KEYS, ...SAFETY_REASON_TEMPLATES.map(item => item.key)].filter(key => !enKeys.has(key));
if (missingSafetyReasons.length) console.error(`[i18n] 安全审批原因缺少英文词条：${missingSafetyReasons.join('、')}`);
const safetyReasonLiterals = [...SAFETY_REASON_KEYS, ...SAFETY_UI_ERROR_KEYS, ...SAFETY_REASON_TEMPLATES.flatMap(item => [item.prefix, item.key, ...(item.suffix ? [item.suffix] : [])])];
const missingAppErrors = [...APP_UI_ERROR_KEYS, ...APP_STATUS_ERROR_KEYS, ...APP_UI_ERROR_TEMPLATES.map(item => item.key)].filter(key => !enKeys.has(key));
if (missingAppErrors.length) console.error(`[i18n] 手机应用错误缺少英文词条：${missingAppErrors.join('、')}`);
const appErrorLiterals = [...APP_UI_ERROR_KEYS, ...APP_STATUS_ERROR_KEYS, ...APP_UI_ERROR_TEMPLATES.flatMap(item => [item.prefix, item.key])];
const missingGuiHostErrors = [...GUI_HOST_ERROR_KEYS, ...GUI_HOST_TIMEOUT_LABELS, ...GUI_HOST_ERROR_TEMPLATES.map(item => item.key), ...GUI_HOST_ERROR_FRAMES.map(item => item.key), ...GUI_HOST_ERROR_COMPOUNDS.map(item => item.key), ...GUI_HOST_ERROR_SUFFIXES.map(item => item.key)].filter(key => !enKeys.has(key));
const missingCliLaunchErrors = [...CLI_LAUNCH_ERROR_KEYS, ...CLI_LAUNCH_ERROR_FRAMES.map(item => item.key)].filter(key => !enKeys.has(key));
if (missingCliLaunchErrors.length) throw new Error(`CLI launch error translations missing: ${missingCliLaunchErrors.join(', ')}`);
const cliLaunchErrorLiterals = [...CLI_LAUNCH_ERROR_KEYS, ...CLI_LAUNCH_ERROR_FRAMES.flatMap(item => [item.prefix, item.suffix, item.key])];
if (missingGuiHostErrors.length) console.error(`[i18n] GUI 会话宿主错误缺少英文词条：${missingGuiHostErrors.join('、')}`);
const guiHostErrorLiterals = [...GUI_HOST_ERROR_KEYS, ...GUI_HOST_TIMEOUT_LABELS, ...GUI_HOST_ERROR_TEMPLATES.flatMap(item => [item.prefix, item.key]), ...GUI_HOST_ERROR_FRAMES.flatMap(item => [item.prefix, item.suffix, item.key]), ...GUI_HOST_ERROR_COMPOUNDS.flatMap(item => [item.prefix, item.separator, item.key]), ...GUI_HOST_ERROR_SUFFIXES.flatMap(item => [item.suffix, item.key])];
const missingUiWidgetHostErrors = UI_WIDGET_HOST_ERROR_KEYS.filter(key => !enKeys.has(key));
if (missingUiWidgetHostErrors.length) console.error(`[i18n] 交互部件宿主错误缺少英文词条：${missingUiWidgetHostErrors.join('、')}`);
const uiWidgetHostLiterals = [...UI_WIDGET_HOST_ERROR_KEYS, '交互状态超出 256 KiB：已用 ', ' 字节，上限 ', ' 字节；请只保存选择 ID 和界面参数', '交互状态 ', ' 必须是有效 JSON'];
const mailboxProtocolFunctions = {
  'src/main/messages/communication.ts': ['deliver', 'boundedAdmission'],
  'src/main/messages/read.ts': ['readMailbox'],
  'src/main/messages/receive.ts': ['receiveMailbox', 'header'],
  'src/main/messages/cursor.ts': ['encodeMailboxCursor', 'decodeMailboxCursor'],
  'src/main/messages/wait.ts': ['mailboxChanges'],
  'src/main/messages/watch.ts': ['watchedSession']
};
const missingSkillConsolidationErrors = [...SKILL_CONSOLIDATION_ERRORS, ...SKILL_CONSOLIDATION_PREFIXES.map(item => item.key)].filter(key => !enKeys.has(key));
if (missingSkillConsolidationErrors.length) console.error(`[i18n] 技能归并错误缺少英文词条：${missingSkillConsolidationErrors.join('、')}`);
const skillConsolidationLiterals = [...SKILL_CONSOLIDATION_ERRORS, ...SKILL_CONSOLIDATION_PREFIXES.flatMap(item => [item.prefix, item.key]), '；原文件已保留或恢复。', '统一源已保存，但旧副本清理未完成：', '；回滚未完成，请检查 '];
const album = photoAlbumExample();
const albumDisplayLiterals = [album.name, album.description, ...album.collections.flatMap(collection => [collection.title, ...collection.fields.map(field => field.label)]), ...album.commands.map(command => command.title), ...album.views.map(view => view.title)];
const extensionReasonLocaleKeys = [...EXTENSION_REASON_KEYS, ...EXTENSION_REASON_TEMPLATES.map(([, key]) => key)];
const missingExtensionReasons = extensionReasonLocaleKeys.filter(key => !enKeys.has(key));
if (missingExtensionReasons.length) console.error(`[i18n] 扩展状态原因缺少词条：${missingExtensionReasons.join('、')}`);
const extensionDisplayDataFiles = new Set(['src/main/extensions/extensionCoordinator.ts', 'src/main/extensions/extensionGlobalState.ts', 'src/main/extensions/extensionSafety.ts', 'src/main/extensions/extensionAppSystem.ts', 'src/main/extensions/extensionHost.ts',
  'src/main/extensions/extensionReplicaTransaction.ts', 'src/main/extensions/extensionWatchService.ts', 'src/main/extensions/extensionNavigation.ts', 'src/main/extensions/extensionNativeRecovery.ts', 'src/main/extensions/extensionStartupDiscovery.ts', 'src/main/extensions/extensionManagement.ts', 'src/main/extensions/extensionReview.ts', 'src/shared/extension.ts', 'src/shared/extensionReason.ts']);
const extensionDisplayLiterals = [...extensionReasonLocaleKeys, ...EXTENSION_REASON_TEMPLATES.map(([prefix]) => prefix), ' 已有无法确认归属的同名扩展，保留原文件',
  '扩展导航配置损坏，已保留至 ', '；已重建默认导航。原因：', '原生扩展恢复记录损坏，已保留：', '；导航暂不可保存。',
  '无法读取扩展导航：', '扩展导航路径不是普通文件：', '扩展导航配置损坏，无法保留原文件 ',
  '原生扩展 ', ' 上次运行异常，已进入安全模式；禁用后重新启用可重试。启动期能力需重启应用。'];

const used = new Map();
const missing = [];
for (const dir of SRC_DIRS) {
  for (const file of walk(path.join(root, dir))) {
    if (file.startsWith(LOCALES_DIR)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const { key, index } of extractTCallKeyPositions(src)) {
      const lineNo = src.slice(0, index).split('\n').length;
      if (!used.has(key)) used.set(key, []);
      used.get(key).push(`${path.relative(root, file)}:${lineNo}`);
      if (!enKeys.has(key)) missing.push({ key, at: `${path.relative(root, file)}:${lineNo}` });
    }
  }
}
const unused = [...enKeys].filter((k) => !used.has(k));

if (missing.length > 0) {
  console.error(`[i18n] 缺英文词条 ${missing.length} 条（补进 src/shared/i18n/locales/）：`);
  for (const { key, at } of missing) console.error(`  ✗ "${key}"  ←  ${at}`);
}
if (unused.length > 0) {
  console.warn(`[i18n] 词条未被字面量引用 ${unused.length} 条（数据驱动 key 属正常，确认后忽略）`);
}

// ---------- ② 裸中文检测 ----------
/**
 * 有意不翻的豁免清单：LLM 提示词 / 协议与文档文本 / 演示数据 / 词表协议。
 * file 用相对 src 的路径子串匹配；lineRe（可选）再限定行内容。
 */
const ALLOWLIST = [
  { file: 'shared/canvasHandover.ts', lineRe: /^\s*(?:const (?:pending|other|tools|native|truncated)\b|return `【交接背景】)/, why: '交接背景和文档行号是发给接续 Agent 的协议文本；界面不展示该背景' },
  { file: 'main/agent/orchestrator/turnExecution.ts', lineRe: /HOST_NOTIFICATION_TRIGGER.*继续处理刚才未完成的宿主事件/, why: '重试宿主事件时发给调度模型的指令，不是界面文本' },
  { file: 'main/agent/providers/hostNotification.ts', lineRe: /session\.prompt\(\`\$\{HOST_NOTIFICATION_TRIGGER\}/, why: '继续处理宿主事件的模型指令，非界面文本' },
  { file: 'main/memory/curatorBindings.ts', lineRe: /^\s*notice:`对照保留完整结论/, why: '记忆整理模型的对照范围和截断说明，发往模型工具结果' },
  { file: 'renderer/src/components/MemoryOverview.tsx', lineRe: /^\s*(?:titleKey|subKey|tipTitleKey|tipKey):\s*'/, why: '记忆总览静态数据键在渲染与提示入口调用 t；专项测试检查每个键的英文词条' },
  { file: 'renderer/src/components/NativeSessionConfig.tsx', lineRe: /^\s*\['(?:permission|approval|approvals|collaboration|sandbox|multitask|workflow|mode|session|reviewer|filesystem|network)[a-z ]*', '/, why: '引擎原生设置字段名的中文展示键；消费点 titleKey ? t(titleKey) : option.name 翻译，全部键已有英文词条（tasks/settings/memory 片段）' },
  { file: 'renderer/src/components/MemoryOverview.tsx', lineRe: /^\s*\{ id: 'e-[\w-]+', .*\bkey: '/, why: '记忆图连线标签渲染时调用 t(L.key)；专项测试检查每个词条' },
  { file: 'renderer/src/components/MemoryOverview.tsx', lineRe: /^\s*(?:auto_admitted|staged|promoted|superseded|approval_queued|approval_decided|direct_write|profile_write|intent_fired|intent_cancelled): /, why: '记忆事件类型映射展示时调用 t；专项测试检查所有词条' },
  { file: 'renderer/src/components/MemoryOverview.tsx', lineRe: /^\s*if\(id==='profile'\)return '长期知识';$/, why: '旧画像路由回落的标签键由调用方翻译' },
  { file: 'renderer/src/memoryCenterRoute.ts', lineRe: /^\s*\{ id: '[a-z]+', labelKey: '/, why: '记忆中心页签键在 KnowledgeCenter 和 MemoryOverview 展示时翻译；专项测试检查全部词条' },
  { file: 'shared/workspaceIcons.ts', lineRe: /^\s*\{ id: '[a-z]+', label: '/, why: '工作区图标标签数据由 AvatarPicker 展示时翻译；专项测试检查全部内置标签' },
  { file: 'shared/subagentCharacters.ts', lineRe: /^\s*\{ id: '[a-z]+', name: '.*', role: '/, why: '内置角色名与职业是身份数据；设置头像和回退名在展示时翻译，历史会话名保留原值；专项测试覆盖所有角色词条' },
  { file: 'shared/agentAppsBuiltins.ts', lineRe: /(?:name:|description:|\b(?:text|flag|body|time)\(|\blabel:|\btitle:|\.title = '删除本地记录'|\[\['unread')/, why: '内置应用声明是持久化定义；展示层按原始值与内置定义逐字段比对后翻译，回归检查覆盖所有标签及自定义名称' },
  { file: 'renderer/src/agentApps/appName.ts', lineRe: /\? '(邮件主题|消息内容|已收藏|已启用|创建)'|app\.name === '(待办|提醒|邮箱|阅读|短信)'/, why: '内置标签上下文翻译键和比对原值；仅对匹配的默认值调用 t，中文保留原值' },
  { file: 'shared/sessionTree.ts', lineRe: /^\s*(?:if \(depth (?:<= 1|=== 2|=== 3)\)|return Number\.isFinite\(depth\))/, why: '会话层级中文标签保持纯函数输出；CenterPanel 展示时翻译，深层数量使用插值' },
  { file: 'shared/rightWorkspace.ts', lineRe: /^\s*if \(content\.kind === 'review'\) return (?:content\.filePath \|\| content\.repoPath \|\| )?'审阅'/, why: '右侧审阅标签纯状态机的回退键；RightWorkspaceToolbar 根据内容类型翻译，不翻译文件路径' },
  { file: 'shared/cliLaunchOptions.ts', lineRe: /\bchoice\(/, why: 'CLI 选项标签是数据键；新建任务界面显示时调用 t，cli-launch-options 回归覆盖内置引擎词条' },
  { file: 'main/handover/documents.ts', lineRe: /^\s*(?!.*\bthrow\b)(?:type MessageRole|\.replace\(|return time|if \(role ===|const round|return \{ owner, lines|const detail|return `\[工具|const other|: message\.role|if \(message\.|else if \(part\.kind === 'thinking'|lines\.push\(`图片|const role: MessageRole|else if \(block\.type === 'thinking'|\} else lines\.push|const truncationNote|append\(`# 会话交接历史)/, why: '交接历史文档及角色标记是发送给接续 Agent 的稳定格式；面向用户的错误单独使用 t()' },
  { file: 'renderer/src/agentApps/AppDataView.tsx', lineRe: /\[\['inbox', '收件箱'\]/, why: '邮件文件夹中文键由列表渲染点 t(title) 翻译' },
  { file: 'renderer/src/chatSurface/agentSessionSurface.tsx', lineRe: /snapshot\.warning\.includes\('尚未读取模型目录'\)/, why: '兼容旧引擎的中文错误比较；显示路径单独翻译' },
  { file: 'renderer/src/chatSurface/UiWidgetCard.tsx', lineRe: /errorRef\.current \|\| '内容渲染失败'|errorRef\.current = '内容加载超时'/, why: '回执协议保留中文状态；错误卡展示时通过 t(error) 翻译' },
  { file: 'renderer/src/components/ChatMessageView.tsx', lineRe: /verb === '(搜索|列目录)'/, why: '工具分类原始词表比较；返回的展示动词使用 t()' },
  { file: 'renderer/src/components/KnowledgePanel.tsx', lineRe: /^\s*const (labels|statuses|scopes)\s*=|^\s*\{\(\[\['problem'/, why: '知识类型、状态、范围及字段标签的数据键；消费点使用 t()' },
  { file: 'renderer/src/components/MemoryProcessingView.tsx', lineRe: /^\s*const (FILTERS|STATES|RESULTS|SCOPES|CORRECTION_RESULTS|KINDS)\b/, why: '处理状态及筛选标签的数据键；展示时使用 t()' },
  { file: 'renderer/src/components/settings/WorkerProductHeader.tsx', lineRe: /return \{ text: '(未注册|已停用|已发现|待检测)'/, why: '产品状态的数据键；SettingsResourceStatus 展示时使用 t()' },
  { file: 'renderer/src/panels/SideToolsPanel.tsx', lineRe: /^\s*const UTILITY_TITLES\b/, why: '工具视图标题键，展示时使用 t(currentDocked.title)' },
  {file:'main/browser/semanticActions.ts',why:'browser.run 的结构化工具结果发给 Agent；页面内闭包经 CDP 序列化且必须自包含，不能引用主进程 i18n'},
  {file:'renderer/src/components/ChatResetDialog.tsx',lineRe:/^\s*export const RESET_MEMORY_PROMPT\s*=/,why:'已注册的记忆提示词，追加到用户草稿并发给模型；确认框文案单独翻译'},
  {file:'main/messages/hostNotifications.ts',lineRe:/^\s*const INSTRUCTION\s*=|source: session\?\.name \|\| '宿主'/,why:'宿主事件注入给模型的指令和来源数据，用户可见摘要另行翻译'},
  {file:'shared/toolDiscovery.ts',why:'按需工具目录、家族用途和参数拒绝信息发给 LLM，非界面文案'},
  {file:'main/agentSession/tools/discovery.ts',lineRe:/description:|throw new Error/,why:'发现/代理的工具描述与拒绝文本发给 LLM；界面 label 单独走 t()'},
  {file:'main/capabilities/hosts/discovery.ts',why:'当前身份目录和代理拒绝信息发给 LLM'},
  {file:'main/capabilities/hosts/actors.ts',why:'宿主可信调用身份与目录范围的工具拒绝信息发给 LLM'},
  {file:'main/messages/interrupt.ts',why:'先存信后打断的阶段回执发给父会话 LLM，非界面按钮'},
  {file:'main/sessions/observe.ts',lineRe:/throw new Error/,why:'只读工具范围/参数错误发给 LLM'},
  {file:'shared/runtimeFactsSubscribe.ts',why:'事件订阅的查询参数拒绝信息发给 LLM，纯函数不依赖界面语言'},
  // 2026-09-26 catalog 拆分：实现体在 main/capabilities/catalog/ 子目录（路径子串匹配一并覆盖垫片 catalog.ts）
  { file: 'main/capabilities/catalog', why: 'Agent 工具目录：发给 LLM 的描述' },
  { file: 'main/browser/webmMuxer.ts', why: 'WebM 复用器纯逻辑零依赖（.mjs 测试可纯转译导入，同 memory/* 口径）；错误文案经 browser.recording 工具结果发给 LLM/写日志，非渲染层 UI' },
  { file: 'main/capabilities/hosts/llm.ts', lineRe: /PROBE_PROMPT_DEFAULT/, why: '思考探针默认提示词（发给模型的内容，非 UI 文案）' },
  { file: 'main/metaAgent/scaffold.ts', why: '工作区脚手架模板' },
  { file: 'main/devSandbox.ts', why: '开发沙箱演示数据（会话名等用户数据种子）' },
  { file: 'main/agent/systemPrompt.ts', why: '调度 LLM 系统提示词' },
  { file: 'main/canvasLink.ts', why: '交接指令：注入临时会话的 LLM 提示词（内置中文模板，发给 Worker）' },
  { file: 'shared/guiWorkerPrompt.ts', why: 'GUI Worker 提示词' },
  { file: 'shared/workerStatusGuard.ts', why: 'P5/P11 回注/warning 文案（发给 Worker，非 UI）' },
  { file: 'main/agentSession/workerTreeGuard.ts', why: 'P11 脏树回注（发给 Worker）' },
  { file: 'shared/workerBrief.ts', why: '派活任务简报（发给 Agent）' },
  { file: 'shared/readState.ts', why: 'read-state 过期提示（发给 Worker 模型的协议文案，非 UI）' },
  { file: 'shared/escalateBudget.ts', why: 'escalate 升级协议纪律与 refused 文案（发给 Worker/调度 Agent，非 UI）' },
  { file: 'shared/skillInject.ts', why: 'skill 预算警告（发给模型的协议文案，非 UI）' },
  { file: 'shared/prReviewBrief.ts', why: 'T1.7 diff 评论回注简报（发给 Worker）' },
  { file: 'shared/agentConduct.ts', why: '全局行为规约种子规则与注入节文本（发给 Agent）' },
  { file: 'shared/journalFormat.ts', why: '工作记录格式合同（标题与状态用于日志序列化）' },
  { file: 'shared/memoryFormat.ts', why: 'memory 格式的托管块/SKILL.md 渲染文案（发给 Agent，单源）' },
  { file: 'main/memory/db.ts', why: '记忆派生库内部错误与写入校验文案：boot 控制台日志与未来 memory.* 工具结果（发给 LLM，非 UI）；模块保持零 i18n 依赖，.mjs 测试可纯转译导入' },
  { file: 'main/memory/indexer.ts', why: '向量策略降级原因文案（写派生库 meta、面板「索引状态」与 memory.* 工具结果读，非渲染层 UI）；模块保持零 i18n 依赖，.mjs 测试可纯转译导入' },
  { file: 'main/memory/provenance.ts', why: '溯源分类 reason 与门描述（写入 staging signals/工具回执/日志，发给 LLM 非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/staging.ts', why: 'staging 写入门拒收 reason/detail（memory.note 工具结果发给 LLM、面板候选列表读，非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/ingest.ts', why: '转录摄入候选启发与跳过原因（日志/staging signals，非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/flush.ts', why: 'flush 静默回合系统提示词与【用户】/【助手】对话标注（发给 flush 模型）、超时/配置错误（降级日志，非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/directWrite.ts', why: '直写门 R-22 预算守卫提醒与校验文案（memory.remember 工具报错发给 LLM，逼当回合合并，非 UI）；零 i18n 依赖' },
  { file: 'main/memory/noteTools.ts', why: 'memory.note/remember 工具核心的直写门拒绝文案（发给 LLM 并指路 memory.note，非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/runtime.ts', why: '写路径钩子的降级 console.warn 与摄入跳过原因（主进程日志，非 UI）；模块含 electron 依赖链不走 .mjs 直测' },
  { file: 'main/memory/consolidation/gates.ts', why: '信号门常量注释与门判定描述（无运行时中文串面；零 i18n 依赖，.mjs 可纯转译导入）' },
  { file: 'main/memory/consolidation/model.ts', why: '巩固静默回合系统提示词（发给巩固模型）、超时/配置错误（降级日志，非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/consolidation/apply.ts', why: '验证组装的 diff 摘要与拒绝分类文案（写 consolidation_log/日志，面板「晋升审阅」读，非渲染层 UI）；零 i18n 依赖，.mjs 可转译直测' },
  { file: 'main/memory/consolidation/approval.ts', why: '审批执行结果错误文案与预览 diff 标签（写 approvals payload/consolidation_log，B6 面板读，非渲染层 UI）；零 i18n 依赖' },
  { file: 'main/memory/consolidation/approvalExec.ts', why: '审批恢复协议的 busy/conflict/zero_applied 等失败文案（随审批结果读面/日志走，非渲染层 UI；与 approval.ts 同口径）；零 i18n 依赖，.mjs 可转译直测' },
  { file: 'main/memory/fileRead.ts', why: '写前读取失败的 MemoryFileReadError 文案（工具结果/日志/审批错误链读，非渲染层 UI；与 directWrite.ts 同口径）；零 i18n 依赖' },
  { file: 'main/memory/consolidation/sweep.ts', why: 'sweep 汇总 diff 摘要（写 consolidation_log）与审批通知标题/正文（经注入的 notify 通道发系统 toast——B6 面板审批页承接渲染，文案随 B6 i18n 收口）；零 i18n 依赖，.mjs 可转译直测' },
  { file: 'main/memory/consolidation/trigger.ts', why: '触发器降级 console.error（主进程日志，非 UI）；零 i18n 依赖，.mjs 可转译直测' },
  { file: 'main/memory/injection.ts', why: 'bootstrap 注入分节文案（节头/挤出标注/调度记忆标记——发给 LLM 的注入协议文本，非渲染层 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/trigger.ts', why: 'trigger 注入紧凑隐藏块文案（发给调度 LLM 的背景提醒，非渲染层 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/lane2.ts', why: 'Lane2 深检索注入块与「未找到相关记录」说明（发给调度 LLM，非渲染层 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/recallIntent.ts', why: '回忆意图词法词表（RECALL_NOUNS 锚定名词表/证据短语/正则——纯检索形态数据，翻译破坏解析）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/brief.ts', why: '简报定向召回段文案（进派活简报发给 LLM，非渲染层 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/transcriptIndex.ts', why: '转录索引 origin 分类描述与常量注释（日志/staging signals，非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/intents.ts', why: '前瞻意图错误文案/通知正文/注入块节标题（工具结果发给 LLM、通知通道发系统 toast，非渲染层 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/intentTool.ts', why: 'intent 工具守卫拒绝文案（发给 LLM 并指路定时任务/memory.note，非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/userProfile.ts', why: 'USER.md 画像写入校验与上限守卫文案（工具结果/面板错误读，非渲染层 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'main/memory/consolidation/profile.ts', why: '画像巩固预览 diff/审批结果/通知正文与提示词常量（写 approvals payload/consolidation_log/notify 通道，面板读，非渲染层 UI）；零 i18n 依赖，.mjs 可转译直测' },
  { file: 'main/agent/providers/modeExtension.ts', why: '模式提示词' },
  { file: 'main/tasks/delegate.ts', why: '委派给 Agent 的消息文本' },
  { file: 'main/pty/injectFile.ts', why: '注入 CLI 的任务前缀' },
  { file: 'shared/metaAgent.ts', why: 'statusVocabulary：写入工作区文件的协议词表' },
  { file: 'shared/integrateRequest.ts', why: '发给 Agent 的合入请求消息' },
  { file: 'shared/microcompactPolicy.ts', why: 'B1 微压缩白名单清单与定向摘要指令（发给压缩摘要模型，非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'shared/compactSummary.ts', why: 'B3 结构化压缩摘要模板六节核心/逐字保留条款/transcript 指针行（发给压缩摘要模型与调度 LLM 的注入文本，非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'shared/dateChangeReminder.ts', why: 'C1 跨日日期提醒注入行（<系统提醒>发给调度 LLM，非 UI）；零 i18n 依赖，.mjs 可纯转译导入' },
  { file: 'shared/schedulerMemory.ts', why: 'R-12 调度记忆注入前缀（【调度记忆】/【态势快照】标记）与 SITUATION.md 快照节标签：回合前缀发给调度 Agent LLM，非 UI；文件零依赖纯函数，不 import i18n' },
  { file: 'shared/agentMessage.ts', why: 'sessions.message 直投/审计文案（发给目标 Worker 与调度审计，非 UI）' },
  { file: 'shared/notifyQueue.ts', lineRe: /formatTaskTransitionDetail|任务翻转|被打回池待认领|待评审（|阻塞|打回重做|恢复任务|重开|认领了任务|回池|打回|该翻转是否入|已验收完成|顺带（/, why: '任务翻转/聚合事件文案与订阅策略「顺带」段：经 orch.send 发给调度 Agent（LLM），与文件内既有聚合文本同口径，非 UI' },
  { file: 'shared/subscriptionPolicy.ts', why: '订阅策略内置规则 note / 解析告警 / 策略全貌说明：经 scheduler.policy.* 工具结果与报错发给调度 LLM（非 UI；文件零依赖纯函数，不 import i18n，host 层报错已 t() 包装）' },
  { file: 'shared/workflow.ts', why: '工作流合同文案（WORKFLOW.md 解析错误/上限原因/问题卡头/run 概览）：经 workflow.* 工具结果、wf.* 报错与【编排事件】发给调度 LLM 与工作流脚本（非 UI；文件零依赖纯函数，不 import i18n）' },
  { file: 'shared/workflowCommand.ts', why: '工作流输入框命令展开指令（只进调度引擎的回合文本，界面显示用户原文；零依赖纯函数，渲染层也引用解析部分）' },
  { file: 'main/workflow/', why: '工作流运行时/内核/存储：wf.* 报错回给工作流脚本、进度事件 detail 经 orch.send 发给调度 LLM、run 日志写 run 记录（非渲染层 UI；用户可见的确认框文案在 wiring.ts 已 t()）' },
  { file: 'shared/orchestratorGuards.ts', lineRe: /认领者|小时`|分钟`/, why: 'needs_review 悬挂守卫（R-04）detail 与时长文案：经 orch.send 发给调度 Agent（LLM），非 UI；文件零依赖不能 import i18n' },
  { file: 'main/orchestrator/settleNotify.ts', lineRe: /请人工核对收口/, why: '收口/收尾提醒（R-09/R-19）detail：经 orch.send 发给调度 Agent（LLM），非 UI；缝模块保持零 i18n 依赖' },
  { file: 'main/orchestrator/prMergedWatch.ts', lineRe: /待人工核对收口|待核对收口|请核对收口/, why: 'PR merged 提醒（R-19）detail：经 orch.send 发给调度 Agent（LLM），非 UI' },
  { file: 'main/orchestrator/events.ts', lineRe: /Worker 回合结束|任务被维度门挡下/, why: 'turn_end 事件 detail（含 O13 尾摘要）与 R-14 维度门红灯 detail：经 orch.send 发给调度 Agent（LLM），与 notifyQueue 聚合文本同口径，非 UI' },
  { file: 'shared/dimensionGates.ts', lineRe: /多语言|动画/, why: 'R-14 维度门标签数据（中文作 t() key，中文即原文无需翻译资源也能显示；badge/detail helpers 已 t() 包装）' },
  { file: 'shared/workbenchCommands.ts', why: '远程工作台命令词表和正则保留原始输入；回复文案走 t()' },
  { file: 'main/feishu/', why: '飞书 CLI 内部日志与交互文本' },
  { file: 'main/agentSession/drivers/', why: 'driver 内部错误与 SDK 交互文本（大多不到 UI）' },
  { file: 'main/agentSession/tools/backgroundTasks.ts', why: 'bgtasks.* 工具描述与结果文本：均发给 LLM（对齐 capabilities/catalog 豁免）' },
  { file: 'shared/nodeRepl.ts', why: 'node-repl 工具用户语言描述与 kernel reset 指引（发给 Worker Agent，非 UI；文件零依赖纯函数，不 import i18n）' },
  { file: 'main/agentSession/tools/nodeRepl.ts', why: 'node_repl.js 工具参数描述与结果文本：均发给 LLM（对齐 capabilities/catalog 豁免）' },
  { file: 'main/agentSession/tools/piModes.ts', why: 'modes.* 工具描述与结果文本：均发给 LLM（对齐 backgroundTasks 豁免）' },
  { file: 'main/agentSession/drivers/pi/modes.ts', why: 'creator 模式 persona（发给 LLM 的提示词数据）；drivers/ 目录白名单已覆盖，此条为显式说明' },
  { file: 'shared/backgroundTasks.ts', lineRe: /结果通知|失败：|未知错误|已取消|完成\$|失败\$|budget |foreground|backgrounded|转后台|落盘|完整输出|退出码/, why: '后台任务结果摘要、输出指针与超时转后台文案：注入引擎上下文/工具结果（发给 LLM，非直接 UI；文件须零依赖不能 import i18n）' },
  { file: 'shared/planApproval.ts', why: 'C2 计划门纯契约文案（确认卡 label/confirmNote 中文原文即 key，消费点 ConfirmDialog 已 t）；文件零依赖纯函数不 import i18n' },
  { file: 'main/encoding/winUtf8.ts', why: '编码兜底内部错误' },
  { file: 'main/ipc/handle.ts', why: '开发者向的 IPC 注册错误' },
  { file: 'main/webAccess/server.ts', lineRe: /token 同时落在|两种用法|落盘失败|生成新凭证|首次启动（文件不存在）|文件损坏（|读取失败（|订阅更新|token 轮换|签名密钥设置/, why: 'dev 引导页 HTML、凭证变更/载入的主进程 console 日志与 label（非 UI；用户可见的 error 文案已 t）' },
  { file: 'renderer/src/webApiShim.ts', why: '浏览器 shim 的连接浮条/错误：刻意不走 i18n 合同——本模块先于 i18n 求值加载（见文件头），浮条中英双写' },
  { file: 'renderer/src/components/settings/FontSettings.tsx', lineRe: /敏捷的棕色狐狸/, why: '字体预览样本（PREVIEW_SAMPLE 字形展示用固定内容，翻译即失效）' },
  { file: 'renderer/src/components/AgentComposer.tsx', lineRe: /includes\('创造'\)/, why: '创造模式判定比较键：按显示名匹配 preset（非 UI 文案，翻译会破坏匹配）' },
  { file: 'shared/linkifyWorkspacePaths.ts', why: '无中文输出（检测器误报行）' },
  // ── shared 数据文件：中文标签是数据（中文作 key），渲染/消费点已 t() ──
  { file: 'shared/keybindings.ts', why: '快捷键动作/分组标签数据（渲染点 KeybindingsPane 已 t）' },
  { file: 'shared/commandPalette.ts', why: 'PALETTE_FILTERS/SETTINGS_TABS/SETTINGS_FIELDS 标签数据（QuickOpen/SettingsModal/collectSettingsHits 已 t）' },
  { file: 'shared/theme.ts', why: '内置主题名 + THEME_UI_GROUPS 色盘标签数据（ThemePane 已 t）' },
  { file: 'shared/frameBackdrop.ts', lineRe: /name: '/, why: '窗口背景模板名数据（中文作 key，渲染点 FrameBackdropPicker 已 t(b.name)）' },
  { file: 'shared/userAvatar.ts', why: '头像悬浮文案/宿主方印是中文 key 与身份字形（文件零依赖不能 import i18n；ChatMessageView 已 t(resolveAvatarTooltip)）' },
  { file: 'shared/gitRepoTree.ts', lineRe: /label: '外部'/, why: '仓库树「外部」根标签数据（渲染点 GitPanel 已 t）' },
  { file: 'shared/workbenchStatus.ts', why: 'isVerboseStatusArg 解析比较词（翻译破坏解析）+ t(变量) 条件翻译行' },
  { file: 'shared/agentRuntimeCapabilities.ts', why: 'GUI runtime 能力 label/description：进 LLM 工具目录，且文件须零依赖（不能 import i18n）' },
  { file: 'shared/mcpConfig.ts', lineRe: /支持直接粘贴/, why: 'MCP_JSON_HINT 模块级常量（不得顶层调 t；消费点 IntegrationsPane 已 t）' },
  { file: 'components/settings/ThemePane.tsx', lineRe: /简体中文/, why: '语言名不翻译' },
  { file: 'panels/GitPanel.tsx', lineRe: /未知仓库|不是 git 仓库/, why: '与主进程错误文本比较（翻译破坏匹配）' },
  { file: 'panels/GitPanel.tsx', lineRe: /会话「\{\{name\}\}」的隔离 worktree/, why: '多行 t() 调用的 key 行（t( 在前一行，检测器按行误报）' },
  { file: 'components/ChatMessageView.tsx', lineRe: /visual\.verb (===|!==)/, why: '与工具动词数据比较（classifyTool 数据中文作 key）' },
  { file: 'components/ToolVisuals.tsx', lineRe: /verb:/, why: '工具动词数据定义（中文作 key，展示侧 liteToolVerb 已 t）' },
  { file: 'components/selectionMenuAreas.ts', why: '划词菜单 label 数据（中文作 key，渲染点 SelectionBar 已 t）' },
  { file: 'renderer/src/store.tsx', lineRe: /待命/, why: 'DEFAULT_BUBBLE 模块级常量（不能模块层 t；消费点已 t）' },
  { file: 'preload/index.ts', why: '开发者向的事件频道断言' },
  { file: 'components/settings/ModelProviderPane.tsx', lineRe: /name: '/, why: 'PRESET_PROVIDERS 预置数据名（渲染点 t(preset.name)，兼作落盘数据）' },
  { file: 'components/settings/AttachmentPolicyFields.tsx', lineRe: /nativeAudio|nativeVideo|nativeFiles/, why: '输入能力复选数据数组（中文作 key，渲染点 t(label)）' },
  { file: 'components/settings/AttachmentToolsSettings.tsx', lineRe: /ffmpegPath|libreOfficePath/, why: '转换工具字段数据数组（中文作 key，渲染点 t(label)/t(tip)）' },
  { file: 'panels/LeftPanel.tsx', lineRe: /(label|title): '/, why: 'UTILITY_ITEMS 数据（渲染点已 t(item.label/title)）' },
  { file: 'shared/textTools.ts', why: '内置「翻译」功能定义：name 落盘为用户数据、prompt 发给 LLM' },
  { file: 'shared/noteAnnotations.ts', why: '批注 token「批注N」是写入草稿/消息的匹配协议（发送展开/摘除/连写检测都按它跑，翻译破坏解析）；文件零依赖不能 import i18n，UI 消费点（划词菜单/药丸提示）已 t' },
  { file: 'components/settings/TextToolsPane.tsx', lineRe: /includes\('未配置'\)/, why: '与主进程错误文本比较（runTextTool 错误分类）' },
  { file: 'main/config.ts', lineRe: /provName/, why: '服务商缺省名落盘为用户数据' },
  { file: 'main/capabilities/hosts/tools.ts', lineRe: /脚手架|scaffold/, why: '生成给扩展脚本文件的注释体（文件内容非 UI）' },
  { file: 'main/protocol/shellApi.ts', lineRe: /会话状态上报|buildStatusProtocolHint|MUSTER_STATUS_URL|看板三档|Body 看板三档|（环境变量/, why: 'Worker 上报协议说明文本（发给 Worker/LLM 的协议）' },
  // 2026-09-26 host 拆分：实现体在 main/agentSession/host/ 子目录（路径子串匹配一并覆盖垫片 host.ts）
  { file: 'main/agentSession/host', lineRe: /\blog\(|【用户】|【助手】|fork 自另一会话/, why: 'host 内部运行日志 + fork 注入给 LLM 的上下文标记' },
  { file: 'shared/chatTime.ts', lineRe: /月|年/, why: '中文日期手写分支（Intl zh 输出与产品习惯不符，有意保留）' },
  { file: 'main/metaAgent/ensureForApp.ts', lineRe: /sessionName: '/, why: '初始化落盘的会话名（用户数据）' },
  { file: 'main/metaAgent/journalExitSummary.ts', why: '退出摘要 LLM 提示词、会话标记与 journal marker（发给 LLM/写入 journal 的协议文本）' },
  { file: 'shared/inboundMcp.ts', why: '入站 MCP 工具结果/协议错误发给 CLI Worker（LLM），非 UI' },
  { file: 'main/inboundMcp/stdioEntry.ts', why: '入站 MCP 身份失败文案发 CLI Worker' },
  { file: 'shared/uiRender.ts', why: 'ui.render 契约校验错误文案随工具结果发给 LLM（对齐 capabilities/catalog 豁免），非 UI' },
  { file: 'main/uiAssets.ts', why: '生成产物；生产运行时源文件由 ui-widget-runtime-i18n.mjs 单独核对，快照由 ui-widget-assets.mjs 检查' },
  { file: 'main/capabilities/hosts/uiWidgets.ts', why: 'ui.render 工具结果/错误文本发给 LLM（对齐 inboundMcp 豁免），非 UI' }
];

function allowlisted(relFile, line) {
  for (const a of ALLOWLIST) {
    if (relFile.includes(a.file)) {
      if (a.lineRe && !a.lineRe.test(line)) continue;
      return a;
    }
  }
  return null;
}

const auditAccepted = new Map(AUDIT_ACCEPTED_LINES.map(item => [`${item.file}:${item.line}`, item]));
function acceptedAuditLine(relFile, line) {
  return auditAccepted.get(`${relFile}:${line}`) ?? null;
}

// These legacy pipeline modules currently have no production consumer. Fail
// the gate if one is added, so their diagnostics must be reclassified first.
const dormantMemoryUsers = {
  KnowledgePipeline: ['src/main/memory/knowledgePipeline.ts', 'src/main/memory/knowledgeProcessing.ts'],
  knowledgeProcessingStatus: ['src/main/memory/knowledgeProcessing.ts'],
  consolidateKnowledge: ['src/main/memory/knowledgeConsolidation.ts'],
  reviewKnowledgeDrafts: ['src/main/memory/knowledgeReview.ts', 'src/main/memory/knowledgePipeline.ts'],
  runKnowledgeStage: ['src/main/memory/knowledgeStage.ts', 'src/main/memory/knowledgePipeline.ts'],
  runMemoryFlushTurn: ['src/main/memory/flush.ts'],
  createFetchFlushModelCall: ['src/main/memory/flush.ts'],
  runConsolidationModelTurn: ['src/main/memory/consolidation/model.ts', 'src/main/memory/consolidation/sweep.ts'],
  runConsolidationSweep: ['src/main/memory/consolidation/sweep.ts'],
  createFetchConsolidationModelCall: ['src/main/memory/consolidation/model.ts'],
  parseMemoryResponsesOutput: ['src/main/memory/modelOutput.ts', 'src/main/memory/flush.ts', 'src/main/memory/consolidation/model.ts']
};
// These guard details currently feed only the scheduler event pump and model
// mailbox. A new production consumer must be audited before the exception holds.
const protocolOnlyUsers = {
  evaluateOrchGuards: ['src/shared/orchestratorGuards.ts', 'src/main/orchestrator/events.ts'],
  // These memory budget and candidate helpers are currently used by memory.run;
  // new consumers must be checked for a human display before masking persists.
  boundedPage: ['src/main/memory/readProjection.ts', 'src/main/capabilities/hosts/memory.ts'],
  boundedTextPage: ['src/main/memory/readProjection.ts', 'src/main/capabilities/hosts/memory.ts'],
  boundedRawTextPage: ['src/main/memory/readProjection.ts', 'src/main/capabilities/hosts/memory.ts'],
  pageInteger: ['src/main/memory/readProjection.ts', 'src/main/capabilities/hosts/memory.ts'],
  captureMemoryEnvironment: ['src/main/memory/environment.ts', 'src/main/memory/knowledgeTools.ts'],
  enqueueMemoryCandidate: ['src/main/memory/curatorRef.ts', 'src/main/memory/knowledgeTools.ts'],
  canvasHandoverTask: ['src/shared/canvasHandover.ts', 'src/renderer/src/components/NewTaskDialog.tsx', 'src/main/ipc/sessions.ts'],
  truncateToolOutput: ['src/main/handover/output.ts', 'src/main/handover/documents.ts'],
  truncateToolPayload: ['src/main/handover/output.ts', 'src/main/handover/documents.ts'],
  // The old browser help directory and focus rejection are diagnostic-only;
  // newly wiring either to production must trigger a fresh display review.
  BROWSER_HELP: ['src/main/browser/browserHelp.ts'],
  browserToolHelp: ['src/main/browser/browserHelp.ts', 'src/main/capabilities/catalog/api.ts'],
  searchHostToolDirectory: ['src/main/capabilities/catalog/api.ts', 'src/main/capabilities/catalog.ts'],
  requestGuestFocus: ['src/main/browser/tabs.ts'],
  // Neither helper has a production caller; a new use must be reviewed.
  unknownRepoI18n: ['src/main/git/workspaceResolve.ts'],
  writeInboundMcpEngineConfigs: ['src/main/inboundMcp/registrar.ts']
};
const dormantReferences = [], newProtocolConsumers = [], violations = [];
for (const dir of SRC_DIRS) {
  for (const file of walk(path.join(root, dir))) {
    if (file.startsWith(LOCALES_DIR)) continue;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (!shouldScanRawChinese(rel, auditHost)) continue;
    // Keep positions and comment-like text inside strings/URLs intact.
    const original = fs.readFileSync(file, 'utf8');
    const disallowedDormant = Object.entries(dormantMemoryUsers).filter(([, users]) => !users.includes(rel)).map(([name]) => name);
    for (const name of findIdentifierReferences(original, disallowedDormant, file)) dormantReferences.push(`${rel}: ${name}`);
    const disallowedProtocol = Object.entries(protocolOnlyUsers).filter(([, users]) => !users.includes(rel)).map(([name]) => name);
    for (const name of findIdentifierReferences(original, disallowedProtocol, file)) newProtocolConsumers.push(`${rel}: ${name}`);
    let raw = stripCommentsPreservingLines(original, file);
    raw = maskConsoleCallsPreservingLines(raw, file, original);
    raw = maskTranslatedCallsPreservingLines(raw, file, original);
    raw = maskRegexLiteralsPreservingLines(raw, file, original);
    // These values are translated at their view consumers; a dedicated test
    // enumerates the actual initializers and requires every English entry.
    if (rel === 'src/main/agent/capabilitiesView.ts') raw = maskDisplayDataPreservingLines(raw, original, { properties: ['initNotes'] }, file);
    if (rel === 'src/main/agent/injection-registry.ts') raw = maskDisplayDataPreservingLines(raw, original, { properties: ['note'] }, file);
    if (rel === 'src/renderer/src/components/settings/CapabilityManagementPane.tsx') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['associationLabels', 'dialogTitle'] }, file);
    if (rel === 'src/shared/defaultBookmarks.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['DEFAULT_BOOKMARKS'] }, file);
    if (rel === 'src/renderer/src/browserHomePreferences.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['HOME_SEARCH_PRESETS'] }, file);
    if (rel === 'src/shared/agentAppsExamples.ts') raw = maskKnownLiteralsPreservingLines(raw, albumDisplayLiterals, file, original);
    if (rel === 'src/renderer/src/components/settings/FontSettings.tsx') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['SCALE_OPTIONS'] }, file);
    if (rel === 'src/renderer/src/components/KnowledgePanel.tsx') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['relation'] }, file);
    if (rel === 'src/renderer/src/components/FeedbackCenter.tsx') {
      raw = maskDisplayDataPreservingLines(raw, original, { variables: ['MANUAL_FIELDS', 'STATUS'] }, file);
      raw = maskVerifiedLabelReferencesPreservingLines(raw, original, { keys: ['类型', '反馈正文', '标题'], callName: 'fieldCaption', comparison: 'section.label' }, file);
    }
    if (rel === 'src/renderer/src/components/MemoryProcessingView.tsx') raw = maskKnownLiteralsPreservingLines(raw, ['审查完成，结果待核对'], file, original);
    if (rel === 'src/renderer/src/components/NewTaskDialog.tsx') raw = maskKnownLiteralsPreservingLines(raw, ['当前引擎不支持此权限模式。', '由引擎审批', '按需询问'], file, original);
    if (rel === 'src/renderer/src/components/ChatMessageView.tsx') raw = maskKnownLiteralsPreservingLines(raw, ['执行命令'], file, original);
    if (rel === 'src/renderer/src/components/settings/GeneralPane.tsx') raw = maskKnownLiteralsPreservingLines(raw, ['简体中文'], file, original);
    if (rel === 'src/shared/attachmentPolicy.ts') {
      // Labels are checked against the actual settings data by capability-display-i18n.
      raw = maskDisplayDataPreservingLines(raw, original, { variables: ['ATTACHMENT_PROCESSING_FIELDS'] }, file);
      // Strict validation errors are returned by llm.run to its model caller, not settings UI.
      raw = maskProtocolFunctionsPreservingLines(raw, original, ['mergeModelAttachmentPolicy'], file);
    }
    if (rel === 'src/main/capabilities/hosts/memory.ts') {
      // Both the exported tool map and its private context validator return only to
      // the model-facing capability executor; human memory IPC is a separate path.
      raw = maskDisplayDataPreservingLines(raw, original, { variables: ['memoryHost'] }, file);
      raw = maskProtocolFunctionsPreservingLines(raw, original, ['context'], file);
    }
    // This initializer is a model instruction, not a user-visible label. Validation
    // and eligibility text in the same file remains checked and translated at UI edges.
    if (rel === 'src/main/memory/knowledgePolicy.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['KNOWLEDGE_EXTRACT_PROMPT'] }, file);
    // This event stores a stable key and arguments, translated by MemoryOverview;
    // memory-overview-i18n inspects the real producer and requires its dictionary entry.
    if (rel === 'src/main/memory/service.ts') raw = maskKnownLiteralsPreservingLines(raw, ['用户画像已更新（{{totalChars}} 字）'], file, original);
    // Outbox subjects are persisted for host-to-agent delivery. The human activity
    // summary is reconstructed and translated by agentApps/notifications.ts;
    // host notices are excluded from mailbox previews and read-mail cards.
    if (rel === 'src/main/agentApps/service.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [
      ['RSS 首次同步完成（', ' 条）'], ['收到 ', ' 条 RSS 更新'], ['', '：', ' 条新内容'], ['', '：1 条新内容']
    ], file, original);
    // These are the service's two host-generated chat availability values;
    // the human IPC translates them while preserving names and unknown reasons.
    if (['src/main/agentApps/service.ts', 'src/main/ipc/agentApps.ts'].includes(rel))
      raw = maskKnownLiteralsPreservingLines(raw, ['已用于遥控调度', '已添加到手机，请编辑原连接'], file, original);
    // Recall is injected into the model turn; the separately exposed branch notice
    // remains scanned and translated for the memory UI.
    if (rel === 'src/main/memory/knowledgeRecall.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['formatKnowledgeHits'], file);
    // Scaffolded skill/readme bodies and the orchestration event prompt are
    // consumed as agent protocol; they are not translated UI or user data.
    if (rel === 'src/shared/notifyQueue.ts') {
      raw = maskDisplayDataPreservingLines(raw, original, { variables: ['KIND_LABEL'] }, file);
      raw = maskProtocolFunctionsPreservingLines(raw, original, ['aggregateOrchEvents'], file);
    }
    if (['src/main/turnChanges/service.ts', 'src/main/turnChanges/tracker.ts', 'src/main/turnChanges/pathCapture.ts', 'src/main/turnChanges/files.ts', 'src/main/agent/orchestrator/buckets.ts', 'src/main/agent/orchestrator/turnExecution.ts', 'src/main/agentSession/host/fileChanges.ts', 'src/shared/guiWorker.ts', 'src/shared/turnChanges.ts', 'src/renderer/src/turnChangeDisplay.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, turnChangeLiterals, file, original);
    if (['src/main/safety/service.ts', 'src/main/safety/bindings.ts', 'src/main/safety/pi.ts', 'src/shared/safetyReason.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, safetyReasonLiterals, file, original);
    // Approval audit strings stay stable for the model and persisted history;
    // the verified host suffixes are projected by localizeSafetyReason in UI.
    if (['src/shared/safetyReason.ts', 'src/main/safety/bindings.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, ['；人工确认通道不可用，未授权', '；审批记录暂不可保存'], file, original);
    if (rel === 'src/main/safety/service.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [['', '；人工确认通道不可用，未授权']], file, original);
    if (rel === 'src/main/safety/service.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [['审批模型取消清理失败：', '']], file, original);
    if (rel === 'src/shared/safetyReason.ts') raw = maskKnownLiteralsPreservingLines(raw, ['审批模型取消清理失败：'], file, original);
    // The approval record keeps the host-generated mailbox summary intact;
    // SafetyPanel and safetyMessageDisplay translate it only for this action.
    if (['src/main/capabilities/hosts/agentApps.ts', 'src/shared/safetyReason.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, ['配置邮箱连接'], file, original);
    // Routine App sends return before audit records or messages are created;
    // app-send-safety guards that this internal summary is never displayed.
    if (rel === 'src/main/agentApps/sendAuthorization.ts') raw = maskKnownLiteralsPreservingLines(raw, [' · 发送'], file, original);
    // The persisted fallback values are displayed through checked provenance;
    // every possible source key is required to have an English resource above.
    if (rel === 'src/shared/appRecordPlaceholders.ts') raw = maskKnownLiteralsPreservingLines(raw, appRecordPlaceholderSources, file, original);
    if (rel === 'src/shared/appConnectionName.ts') raw = maskKnownLiteralsPreservingLines(raw, appConnectionNamePlaceholders.flatMap(item => [item.source, item.key]), file, original);
    // Backward-compatible preload fallback when an old appearance message has
    // no localized activation hint; the current browser host sends a t() value.
    if (rel === 'src/main/browser/tabs.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['VIEW_ACTIVATION_FALLBACK'] }, file);
    // Scheduler usage keeps its stored name stable; the stats view translates
    // the default only when the scheduler identity and original name match.
    if (['src/main/agent/orchestrator/turnExecution.ts', 'src/renderer/src/components/UsageStatsPanel.tsx'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, ['调度 Agent'], file, original);
    // Historical runtime identity remains stable for restoration; CenterPanel
    // translates only its fallback label when no user registration exists.
    if (rel === 'src/shared/retiredServiceRuntimes.ts') raw = maskKnownLiteralsPreservingLines(raw, ['Cursor（旧会话）'], file, original);
    // Usage records retain default diagnostics as written; the statistics view
    // translates only these known fallbacks and leaves supplied errors intact.
    if (['src/main/usage/service.ts', 'src/renderer/src/components/UsageStatsPanel.tsx'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, ['已取消', '调用失败，未提供原因'], file, original);
    // Guard, reflog and merge event details are model-mailbox and workflow tap
    // payloads; the human transcript shows a localized notification count.
    if (rel === 'src/shared/orchestratorGuards.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['evaluateOrchGuards'], file);
    if (rel === 'src/main/orchestrator/events.ts') raw = maskKnownLiteralsPreservingLines(raw, ['主仓脏文件挡住合入：', 'git reflog 更新（提交落树）', '并发位释放，排队 ', ' / 活跃 ', ' / 上限 '], file, original);
    if (rel === 'src/main/orchestrator/prMergedWatch.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['notifyMergedPr'], file);
    // The subject prefix recognizes host event mail and is translated at the
    // read-letter display boundary, without modifying the stored subject.
    if (rel === 'src/shared/mailReadPresentation.ts') raw = maskKnownLiteralsPreservingLines(raw, ['事件通知：'], file, original);
    if (['src/shared/mailboxUserErrors.ts', 'src/main/messages/deliver.ts', 'src/main/metaAgent/messageStore.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, mailboxErrorLiterals, file, original);
    if (rel === 'src/main/messages/deliver.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [['信件正文过长（最多 ', ' 字符），未保存'], ['收信会话不存在：', '']], file, original);
    if (rel === 'src/main/metaAgent/messageStore.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [
      ['旧邮箱读取失败，迁移未完成：', ''], ['旧邮箱迁移失败，原文件已保留：', ''], ['邮箱索引读取失败，已保留原文件：', ''],
      ['信件正文超过 ', ' 字符，未保存'], ['信件 ', ' 正文读取失败：', '']
    ], file, original);
    if (['src/shared/appUserErrors.ts', 'src/main/agentApps/connectors.ts', 'src/main/agentApps/credentialPolicy.ts', 'src/main/agentApps/images.ts', 'src/main/agentApps/managedImageSource.ts', 'src/main/agentApps/service.ts', 'src/main/agentApps/sqliteStateStore.ts', 'src/main/agentApps/serviceClient.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, appErrorLiterals, file, original);
    if (['src/shared/guiHostError.ts', 'src/shared/guiInheritMeta.ts', 'src/shared/runtimeCommunication.ts', 'src/shared/externalPiModel.ts', 'src/main/sessions/createTerminal.ts', 'src/main/handover/paths.ts', 'src/main/agentSession/persist.ts', 'src/main/agentSession/harnessModelIdentity.ts', 'src/main/agentSession/host/agentSessionHost.ts', 'src/main/agentSession/process/owner.ts', 'src/main/agentSession/process/windowsJob.ts', 'src/main/agentSession/process/windowsJobAsset.ts', 'src/main/agentSession/host/sessionOps.ts', 'src/main/agentSession/host/forkDelivery.ts', 'src/main/agentSession/host/lifecycle.ts', 'src/main/agentSession/host/messaging.ts', 'src/main/agentSession/host/turn.ts', 'src/main/agentSession/host/connection.ts', 'src/main/agentSession/host/events.ts', 'src/main/agentSession/host/retirement.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, guiHostErrorLiterals, file, original);
    if (rel === 'src/shared/guiInheritMeta.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [
      ['runtime ', ' 是 CLI 接入，不接受 GUI model 参数；请使用该 CLI 的原生模型配置'],
      ['runtime ', ' 的 model.providerId 必须为 ', '，收到 ', '']
    ], file, original);
    // Model-facing preflight formatting remains stable; settings and user IPC
    // project the known installation hint and separators in the active locale.
    if (rel === 'src/shared/runtimePreflight.ts') {
      raw = maskKnownLiteralsPreservingLines(raw, ['npm install -g opencode-ai（或 npm install -g @google/gemini-cli）'], file, original);
      raw = maskVerifiedTemplatesPreservingLines(raw, [['；修复：', ''], ['；参见：', '']], file, original);
    }
    // One connection note is injected into the model prompt; the other is sent
    // only to host/base.log (console). Neither is a workbench label.
    if (rel === 'src/main/agentSession/host/connection.ts') raw = maskKnownLiteralsPreservingLines(raw, [
      '连接配置已变化（模型或工作区目录），重建连接（历史经 resume token 续聊）',
      'Cursor CLI 通过 --add-dir 接收额外可写目录。权限请求和宿主工具按目录范围判定；Cursor 原生工具及系统沙箱以其自身行为为准。'
    ], file, original);
    if (rel === 'src/main/agentSession/host/turn.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [
      ['网络中断，', ' 后自动续作 ', '/', '（', '）：', ''] // host/base.log only; the UI retry hint uses t().
    ], file, original);
    // The complete fork cleanup envelope and the protection suffix are
    // projected by localizeGuiHostError; preserve interpolated diagnostics.
    if (rel === 'src/main/agentSession/host/sessionOps.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [
      ['分叉数据准备失败：', '；清理临时数据失败：', '（会话 ', '）'],
      ['（已创建原生会话 ', '）'] // The fork result display boundary translates the host suffix.
    ], file, original);
    if (rel === 'src/main/agentSession/host/forkDelivery.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [
      ['；保护记录无法保存：', '']
    ], file, original);
    if (rel === 'src/main/sessions/persister.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [
      ['会话注册表严格写入失败：', '；重新排队失败：', '']
    ], file, original);
    if (rel === 'src/main/tasks/delegateLaunch.ts') {
      raw = maskVerifiedTemplatesPreservingLines(raw, [['会话不存在：', ''], ['会话 ', ' 启动失败：', '；原会话保留']], file, original);
      raw = maskKnownLiteralsPreservingLines(raw, ['进程已退出'], file, original);
    }
    if (rel === 'src/main/git/service.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [['；创建失败后目录已保留，请检查：', '']], file, original);
    if (rel === 'src/main/sessions.ts') raw = maskKnownLiteralsPreservingLines(raw, guiHostErrorLiterals, file, original);
    if (rel === 'src/main/git/workspaceResolve.ts') raw = maskKnownLiteralsPreservingLines(raw, unusedRepoLabels, file, original);
    if (rel === 'src/main/inboundMcp/registrar.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [['无法解析 ', '（JSON 格式错误）。为避免覆盖已有配置，本次入站 MCP 安装中止；请先修复该文件后重试。']], file, original);
    if (rel === 'src/shared/gitUserErrors.ts') raw = maskKnownLiteralsPreservingLines(raw, ['；创建失败后目录已保留，请检查：'], file, original);
    if (rel === 'src/main/extensions/extensionStartupDiscovery.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [
      ['', '/', ': 无法清理启动标记：', ''], ['', '/', ': 启动标记清理失败：', '']
    ], file, original);
    // The timeout word here selects a translated template; it is never displayed on its own.
    if (rel === 'src/shared/guiHostError.ts') raw = maskKnownLiteralsPreservingLines(raw, ['进程已退出', '超时'], file, original);
    if (rel === 'src/main/ipc/agentSession.ts') raw = maskKnownLiteralsPreservingLines(raw, catalogRequestLabels, file, original);
    // The request helper retains its original protocol message. Catalog IPC and
    // the GUI host display independently translate tagged/known host deadlines.
    if (rel === 'src/main/agentSession/processReclamation.ts') raw = maskKnownLiteralsPreservingLines(raw, ['超时', '已取消'], file, original);
    if (['src/shared/cliLaunchOptions.ts', 'src/shared/cliLaunchError.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, cliLaunchErrorLiterals, file, original);
    if (['src/main/attachments/access.ts', 'src/main/attachments/piExtension.ts', 'src/main/agent/providers/hostNotification.ts', 'src/main/agent/skillSources.ts', 'src/shared/subagentCharacters.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, guiHostErrorLiterals, file, original);
    if (rel === 'src/shared/guiPermissionOptions.ts') raw = maskKnownLiteralsPreservingLines(raw, [...permissionLabels], file, original);
    // Mailbox reads and wake-delivery reasons reach the agent tool contract or
    // its persisted wakeError, not workbench UI. Keep those protocol messages
    // stable and restrict the exception to the verified functions/constant.
    if (mailboxProtocolFunctions[rel]) raw = maskProtocolFunctionsPreservingLines(raw, original, mailboxProtocolFunctions[rel], file);
    if (rel === 'src/main/messages/communication.ts') raw = maskKnownLiteralsPreservingLines(raw, ['当前接入未提供原生消息通道'], file, original);
    if (rel === 'src/main/messages/receive.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['NOTE'] }, file);
    // Candidate and correction validation is reached via memory.run, while
    // the consolidation constant is sent as a model prompt.
    if (rel === 'src/main/memory/knowledgeTools.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['submitCandidate', 'correctKnowledge'], file);
    if (rel === 'src/main/memory/readProjection.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['boundedPage', 'boundedRawTextPage', 'pageInteger'], file);
    if (rel === 'src/main/memory/environment.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['captureMemoryEnvironment'], file);
    if (rel === 'src/main/memory/curatorRef.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['enqueueMemoryCandidate'], file);
    // Task bodies and handover snapshots are delivered as source material to the
    // receiving agent; their stable annotations are not workbench UI labels.
    if (rel === 'src/shared/canvasHandover.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['canvasHandoverTask'], file);
    if (rel === 'src/main/handover/output.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['truncateToolOutput', 'truncateToolPayload'], file);
    if (rel === 'src/main/browser/browserHelp.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['BROWSER_HELP'] }, file);
    if (rel === 'src/main/browser/tabs.ts') raw = maskKnownLiteralsPreservingLines(raw, ['capability_unsupported: 后台 DOM 操作不支持请求前台焦点'], file, original);
    // Journal writes and searches are model tools (or an exit summary); their
    // persisted document syntax and tool diagnostics remain stable. Shared
    // read/drain errors still stay in the scan for the journal app boundary.
    if (rel === 'src/main/memory/journal.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['text', 'validate', 'writeJournal', 'searchJournal'], file);
    if (rel === 'src/main/memory/knowledgeConsolidation.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['KNOWLEDGE_CONSOLIDATION_PROMPT'] }, file);
    // The only consumers of this parser are the guarded dormant model paths.
    if (rel === 'src/main/memory/modelOutput.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['parseMemoryResponsesOutput'], file);
    if (rel === 'src/main/memory/knowledgeReview.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['KNOWLEDGE_REVIEW_PROMPT'] }, file);
    if (rel === 'src/main/memory/curator/prompt.ts') {
      raw = maskDisplayDataPreservingLines(raw, original, { variables: ['MEMORY_CURATOR_SYSTEM_PROMPT', 'MEMORY_CURATOR_COMPACTION_PROMPT'] }, file);
      raw = maskProtocolFunctionsPreservingLines(raw, original, ['formatCuratorCandidates', 'formatCuratorUserInput', 'formatCuratorReceiptRepair'], file);
    }
    if (rel === 'src/main/memory/knowledgeEvents.ts') raw = maskKnownLiteralsPreservingLines(raw, ['用户原始输入：\n', '本轮用户要求（仅作背景，不从中重复提取）：\n', '\n本轮助手结论（未核实，不能声称真实运行通过）：\n'], file, original);
    // Linked search reasons retain user summaries and relation codes; their
    // fixed host envelope is translated by localizeKnowledgeHostText.
    if (rel === 'src/main/memory/knowledgeSearch.ts') raw = maskKnownLiteralsPreservingLines(raw, ['关联依据：', '（', '，仅一跳）'], file, original);
    if (rel === 'src/renderer/src/components/KnowledgePanel.tsx') raw = maskKnownLiteralsPreservingLines(raw, ['没有完整的轮次快照或仓库/分支依据，不能还原代码证据'], file, original);
    // Validation diagnostics retain stable model-facing text and are projected
    // in the human IPC; unrelated expressions on the same line remain checked.
    if (rel === 'src/main/memory/knowledgePolicy.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [['', ' 格式或长度错误'], ['', ' 必须是短文本数组']], file, original);
    if (rel === 'src/shared/knowledgeDisplayText.ts') raw = maskKnownLiteralsPreservingLines(raw, ['格式或长度错误'], file, original);
    // These exact progress/error envelopes are translated when the curator
    // transcript and processing records are displayed. The request-ID text is
    // supplied only to the model and must remain stable for that contract.
    if (rel === 'src/main/memory/curator/runtime.ts') raw = maskVerifiedTemplatesPreservingLines(raw, [
      ['', '\n宿主绑定的请求候选ID：', ''],
      ['收到 ', ' 条记忆候选，核对依据与已有知识。'],
      ['已确认 ', ' 条处理回执，正在补齐剩余 ', ' 条。'],
      ['本批已确认 ', '/', ' 条处理回执，剩余 ', ' 条经补结算仍未取得回执；已保留确认结果，未完成项可重试'],
      ['本批已确认 ', '/', ' 条处理回执，剩余 ', ' 条；已保留确认结果。', '', ''],
      ['；回执复核失败：', '']
    ], file, original);
    // Notification defaults are instructions in the scheduler payload, not labels.
    if (rel === 'src/main/agentApps/notifications.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['defaults'] }, file);
    // These are recognition tokens for existing handover documents, not UI labels.
    if (rel === 'src/shared/handoverWait.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['HANDOVER_HEADINGS'] }, file);
    // Handover transcript section markers are persisted document syntax and
    // part of the model's source material, not workbench chrome.
    if (rel === 'src/main/handover/documents.ts') raw = maskKnownLiteralsPreservingLines(raw, [
      '## [审批详情 #', ']\n\n所属消息：', '## [工具详情 #', '所属消息：', '调用记录：', '返回结果：',
      '# 附录：工具调用详情\n\n', '# 附录：原生记录\n\n', '未知工具'
    ], file, original);
    // These protocol errors remain unchanged in author/agent receipts; workbench
    // chrome localizes the verified host diagnostics at the display boundary.
    if (['src/shared/uiWidgetHostErrors.ts', 'src/shared/uiWidgetProtocol.ts', 'src/main/uiWidgetStore.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, uiWidgetHostLiterals, file, original);
    // Artifact updates, inspection and the hidden smoke run report to ui.render/ui.inspect,
    // and do not surface their diagnostic protocol as workbench labels.
    if (rel === 'src/main/uiWidgetStore.ts') raw = maskKnownLiteralsPreservingLines(raw, ['更新须保留原部件的展示方式', '更新内容超出 '], file, original);
    if (rel === 'src/main/uiWidgetSmoke.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['buildUiWidgetSmokePage', 'executeSmoke'], file);
    if (rel === 'src/main/uiWidgetInspect.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['inspectUiWidgets'], file);
    // Terminal waiting is a model tool; these budget helpers currently have
    // no production callers and their pure return values are test contracts.
    if (rel === 'src/main/pty/outputWait.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['waitForTerminalOutput'], file);
    if (rel === 'src/shared/backgroundTasks.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['sanitizeBgBudget', 'budgetBreachReason'], file);
    if (rel === 'src/main/attachments/convert.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['convertAttachment'], file);
    // The appended-worktree return and validation error are consumed by the
    // sessions.isolate model tool. User-visible notifications are translated.
    if (rel === 'src/main/git/worktreeAttach.ts') raw = maskKnownLiteralsPreservingLines(raw, ['追加嵌套成员请直接选择实际子仓，不重建已有容器', '原 cwd 不变；新目录将在下一次连接捕获中登记。CLI 需重拉/续作才更新启动目录权限，当前连接不要假定已获访问。追加未执行准备脚本，依赖需在任务树按需准备。'], file, original);
    // Document conversion is consumed by the model attachment tool or folded
    // into model-facing attachment metadata. It is not a workbench UI message.
    if (rel === 'src/main/attachments/document.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['convertDocument'], file);
    if (rel === 'src/main/attachments/service.ts') raw = maskKnownLiteralsPreservingLines(raw, ['本条消息的图片预算已用完', '视频未解码出任何帧'], file, original);
    // Corrupt-credential details are used only by the server's diagnostic log;
    // user-visible read failures keep their independently translated wrapper.
    if (rel === 'src/main/webAccess/credentials.ts') raw = maskKnownLiteralsPreservingLines(raw, ['JSON 解析失败：', '文件内容不是对象', 'token 缺失或形态非法'], file, original);
    if (rel === 'src/main/memory/knowledgeConsolidation.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['consolidateKnowledge'], file);
    if (rel === 'src/main/memory/knowledgeReview.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['reviewKnowledgeDrafts'], file);
    if (rel === 'src/main/memory/knowledgeStage.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['runKnowledgeStage'], file);
    if (rel === 'src/main/memory/knowledgeProcessing.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['knowledgeProcessingStatus'], file);
    if (rel === 'src/main/memory/knowledgePipeline.ts') raw = maskKnownLiteralsPreservingLines(raw, [
      '缺少稳定事件身份或时间', '记忆事件超过24K上限；宿主需按真实轮次分段', '事件抽取不能扩大到全局画像', '同一事件身份对应不同内容：',
      '事件处理租约已失效', '记忆抽取', '价值审查', '记忆处理正在运行，请等待当前批次结束后重试。', '记忆处理已停止，请重新打开工作区。'
    ], file, original);
    // Skill expansion returns warnings as part of the engine input/worker brief;
    // neither caller renders these protocol strings as a separate UI label.
    if (rel === 'src/main/agent/skillInject.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['sourceChoices', 'expandSkillTextWithBudget', 'appendNamedSkillsToBrief'], file);
    if (rel === 'src/shared/confirmDialog.ts') raw = maskKnownLiteralsPreservingLines(raw, ['合入', '删除'], file, original);
    if (['src/main/capabilityManagement/skillConsolidation.ts', 'src/renderer/src/panels/skillConsolidationDisplay.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, skillConsolidationLiterals, file, original);
    if (rel === 'src/renderer/src/panels/PrReviewPanel.tsx') {
      raw = maskDisplayDataPreservingLines(raw, original, { variables: ['CHECK_LABELS', 'DECISIONS', 'REVIEW_EVENTS'] }, file);
    }
    if (rel === 'src/renderer/src/chatSurface/safetyMessageDisplay.ts') raw = maskDisplayDataPreservingLines(raw, original, { variables: ['STATUS_LABELS'] }, file);
    if (rel === 'src/renderer/src/chatSurface/safetyMessageDisplay.ts') raw = maskKnownLiteralsPreservingLines(raw, [
      ...safetyReasonLiterals, '通过', '本次审批已由人工确认弹窗接管。聊天消息不会批准操作，请在弹窗中确认或拒绝。',
      '。已转交人工确认弹窗，请在弹窗决定本次操作。', '。人工确认通道不可用，本次操作未授权；请恢复确认通道后重新提交。'
    ], file, original);
    if (rel === 'src/main/safety/service.ts') raw = maskKnownLiteralsPreservingLines(raw, [
      '审批请求：', '用户在人工确认弹窗中', '批准', '拒绝', '本次操作：', '通过',
      '已转交人工确认弹窗，请在弹窗决定本次操作。', '人工确认通道不可用，本次操作未授权；请恢复确认通道后重新提交。',
      '本次审批已由人工确认弹窗接管。聊天消息不会批准操作，请在弹窗中确认或拒绝。',
      '本次审批状态：', '。聊天消息不会重新审批；需要重试时请从原操作入口重新提交。'
    ], file, original);
    // The curator SDK sends these specific tool diagnostics to its model. User-facing
    // knowledge-center IPC and unrelated strings in the same file remain checked.
    if (rel === 'src/main/memory/knowledgeStore.ts') raw = maskModelDiagnosticsPreservingLines(raw, { className: 'KnowledgeStore', methodName: 'commitCuratorDecision' }, file, original);
    if (['src/main/memory/knowledgeStore.ts', 'src/main/memory/knowledgeUserErrors.ts', 'src/main/memory/knowledgeHistory.ts', 'src/main/memory/curatorPolicy.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, knowledgeErrorLiterals, file, original);
    if (['src/shared/knowledge.ts', 'src/main/memory/knowledgeHistory.ts', 'src/renderer/src/components/KnowledgeHistory.tsx'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, historyDisplayLiterals, file, original);
    if (['src/main/memory/knowledgePolicy.ts', 'src/main/memory/knowledgeStore.ts', 'src/main/memory/layout.ts', 'src/main/memory/profileProvenance.ts', 'src/main/memory/curator/runtime.ts', 'src/main/memory/curator/queue.ts', 'src/main/memory/curator/pi.ts', 'src/main/memory/curator/budget.ts', 'src/main/memory/curatorIpc.ts', 'src/main/memory/curatorBindings.ts', 'src/shared/knowledgeDisplayText.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, [...knowledgeDisplayLiterals, '保留差异'], file, original);
    if (['src/main/memory/knowledgeStore.ts', 'src/shared/knowledgeDisplayText.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, evidenceDiagnosticLiterals, file, original);
    if (['src/main/memory/curator/draftDiagnostics.ts', 'src/shared/knowledgeDisplayText.ts'].includes(rel)) raw = maskKnownLiteralsPreservingLines(raw, [...knowledgeDisplayLiterals, ...draftDiagnosticLiterals], file, original);
    if (rel === 'src/main/memory/curator/queue.ts') raw = maskKnownLiteralsPreservingLines(raw, ["UPDATE candidates SET state='failed',error='处理进程中断，有限重试已用尽',claim=NULL,lease_until=NULL WHERE state='running' AND lease_until<=? AND attempts>=3"], file, original);
    if (rel === 'src/main/memory/curator/tools.ts') raw = maskModelDiagnosticsPreservingLines(raw, { functionName: 'createCuratorTools' }, file, original);
    // Bound evidence text and its validation errors are sent to the memory model/tool caller;
    // the user-facing memory IPC and notifications are checked separately.
    if (rel === 'src/main/memory/curatorBindings.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['bindCandidateEvidence'], file);
    if (rel === 'src/main/agentSession/host/sessionOps.ts') raw = maskProtocolFunctionsPreservingLines(raw, original, ['forkTranscriptFromSeeds'], file);
    if (rel === 'src/renderer/src/components/MarkdownBody.tsx') raw = maskProtocolFunctionsPreservingLines(raw, original, ['warmMarkdownParser'], file);
    if (rel === 'src/renderer/src/panels/GlobalBoard.tsx') raw = maskCssCommentsPreservingLines(raw, file, original);
    // The AI tool generator passes this non-displayed request identity through
    // validation; runTextTool sends the separate prompt and text, not this name.
    if (rel === 'src/renderer/src/components/settings/TextToolsPane.tsx') raw = maskKnownLiteralsPreservingLines(raw, ['AI 助手'], file, original);
    // These exact fragments describe a diagnostic sent to reportRendererError,
    // and the concurrency cap returned only by the bgtasks model tools.
    if (rel === 'src/renderer/src/longtaskDiag.ts') raw = maskKnownLiteralsPreservingLines(raw, ['长任务 ', 'ms（累计未落盘 ', '会话 ', '无'], file, original);
    if (rel === 'src/main/agentSession/background/manager.ts') raw = maskKnownLiteralsPreservingLines(raw, ['后台任务并发已达上限（', '），请先完成/取消部分任务'], file, original);
    // Only enumerated status keys are persisted as data and translated by the manager;
    // an unrelated raw literal on the same line still fails the scan.
    if (extensionDisplayDataFiles.has(rel)) raw = maskKnownLiteralsPreservingLines(raw, extensionDisplayLiterals, file, original);
    for (const hit of scanRawChineseLines(raw, line => !!allowlisted(rel, line), file, original)) {
      if (auditHost && acceptedAuditLine(rel, hit.line)) continue;
      violations.push(`${rel}:${hit.line}: ${hit.text.slice(0, 90)}`);
    }
  }
}
if (violations.length > 0) {
  console.error(`[i18n] 裸中文（未走 t() 且不在豁免清单）${violations.length} 行：`);
  for (const v of violations) console.error('  ✗ ' + v);
}
if (dormantReferences.length) console.error(`[i18n] 旧记忆管线已接入生产，请重新核对文案：${dormantReferences.join('、')}`);
if (newProtocolConsumers.length) console.error(`[i18n] 模型协议文本出现新的生产消费者，请重新核对展示边界：${newProtocolConsumers.join('、')}`);

// The line-oriented audit above cannot see unquoted JSX text and can skip a raw
// sibling when another expression on the same line calls t(). Parse actual JSX
// nodes separately so those user-facing strings cannot silently escape the gate.
const jsxViolations = [];
for (const file of walk(path.join(root, 'src', 'renderer'), [], /\.tsx$/)) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const source = fs.readFileSync(file, 'utf8'), lines = source.split('\n');
  for (const item of scanJsxChinese(source, file)) {
    const line = lines[item.line - 1] ?? '';
    if (!allowlisted(rel, line)) jsxViolations.push(`${rel}:${item.line}: ${item.text.slice(0, 90)}`);
  }
}
if (jsxViolations.length > 0) {
  console.error(`[i18n] JSX 中未翻译的文本或无障碍属性 ${jsxViolations.length} 处：`);
  for (const v of jsxViolations) console.error('  ✗ ' + v);
}

console.log(
  `[i18n-coverage] 原文扫描范围：${auditHost ? '全部源码（含模型协议与持久数据）' : '渲染层（主进程请另行审计）'} / t() 字面量 key ${used.size} 个 / 词条 ${enKeys.size} 条 / 缺失 ${missing.length} / 未引用 ${unused.length} / 裸中文 ${violations.length} 行 / JSX ${jsxViolations.length} 处`
);
if (missing.length > 0 || missingExtensionReasons.length > 0 || missingBookmarkLabels.length > 0 || missingOtherLabels.length > 0 || missingInjectionNotes.length > 0 || missingTurnChangeText.length > 0 || missingKnowledgeErrors.length > 0 || missingKnowledgeDisplay.length > 0 || missingSafetyReasons.length > 0 || missingAppErrors.length > 0 || missingGuiHostErrors.length > 0 || missingUiWidgetHostErrors.length > 0 || missingSkillConsolidationErrors.length > 0 || dormantReferences.length > 0 || newProtocolConsumers.length > 0 || violations.length > 0 || jsxViolations.length > 0 || duplicates.length > 0) process.exit(1);
