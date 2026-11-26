/**
 * Muster / 集序 的产品身份合同。
 *
 * 运行时身份、安装器身份和本地存储身份必须从这里派生，避免只改窗口标题
 * 却继续复用旧应用的 userData、实例注册表或单实例标识。
 *
 * 命名分工（用户 2026-11-10 定规矩，别再混写）：
 * - `PRODUCT_NAME` 是**身份名**：纯 ASCII、只做技术标识——app 名/UA、安装器、日志、CLI、
 *   脚手架、反馈环境行、协议与路径相关派生。中文名进这些位置会直接把功能打坏
 *   （UA 里的中文曾让 Electron 43 的 protocol.handle 全线抛错，见 asciiUserAgent）。
 * - `PRODUCT_NAME_ZH` 是**展示名**：只许出现在用户可见文案里（`t()` 词条 key），
 *   由 i18n 决定中文界面显示「集序」、英文界面显示 `PRODUCT_NAME`。
 * - 禁止再造 `Muster Console · 集序` 这种中英混排名字。
 */
export const PRODUCT_BRAND = 'Muster';
/** 身份名：纯 ASCII，勿在中英之间加分隔符或中文 */
export const PRODUCT_NAME = 'Muster Console';
/** 展示名：仅中文界面文案使用（英文界面词条回落 PRODUCT_NAME） */
export const PRODUCT_NAME_ZH = '集序';
export const PRODUCT_SLOGAN = '多多益善，集序有方。';
export const PRODUCT_EASTER_EGG = 'Inspired by Han Xin’s muster.';

export const PRODUCT_PACKAGE_NAME = 'muster-console';
export const PRODUCT_APP_ID = 'com.zhanghexie.muster.console';
export const PRODUCT_EXECUTABLE_NAME = 'MusterConsole';
export const PRODUCT_STORAGE_DIR = 'muster-console';
export const PRODUCT_INSTANCE_DIR_NAME = 'muster-console-instances';
export const PRODUCT_CLI_NAME = 'muster';
export const PRODUCT_CLI_EXECUTABLE = 'MusterConsole.exe';
export const PRODUCT_CLI_HOME_ENV = 'MUSTER_CLI_HOME';
export const PRODUCT_CLI_HOME_DIR = '.muster-console-cli';

/**
 * 把 Electron 默认 UA 清洗成纯 ASCII（主进程启动期调用一次，防御性兜底）。
 *
 * 由来：产品名曾是 `Muster Console · 集序`，Electron 用产品名拼默认 UA（去空格）后得到
 * `MusterConsole·集序/0.1.34 …`。Electron 43.x 的 `protocol.handle` 要把请求头转成
 * WebIDL `Headers`，非 Latin-1 字符（≥U+0100）在 ByteString 转换处直接抛
 * `TypeError: Cannot convert argument to a ByteString because the character at index N has
 * a value of 65533`，异常发生在 handler 之前，浏览器侧只看到 `net::ERR_UNEXPECTED`——
 * 所有自定义协议（muster-ws / muster-root / muster-ext / muster-app）一起失效，表现为
 * 图片、音视频、PDF、HTML、扩展面板整片打不开而文件确实存在（2026-11-10 实机定位）。
 *
 * 产品名已改为纯 ASCII，正常情况本函数是恒等变换；保留它是因为「名字一改就把全类型预览
 * 打挂」的代价太高，任何未来的非 ASCII 产品名/品牌词都要在下游被挡住。
 *
 * @param userAgent Electron 默认 UA（`app.userAgentFallback`）
 * @param productToken 产品名整段非 ASCII 时用来补段的 ASCII 令牌
 */
export function asciiUserAgent(
  userAgent: string,
  productToken: string = PRODUCT_EXECUTABLE_NAME
): string {
  const cleaned = userAgent.replace(/[^\x20-\x7e]+/g, '').replace(/ {2,}/g, ' ').trim();
  // 产品名整段被清掉后产品段只剩 `/<版本>`：补回 ASCII 令牌，别留裸斜杠
  return cleaned.replace(/(^|\s)\/(?=\d)/g, `$1${productToken}/`);
}
