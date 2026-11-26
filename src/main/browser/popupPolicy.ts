/**
 * window.open 分流策略（纯逻辑，test/browser-popup-policy.mjs 直测）。
 *
 * 背景：弹窗式 OAuth（微信/QQ/GitHub 扫码登录等）依赖三条原生窗口契约——
 * 1) window.open() 返回弹窗引用（原页面用它 postMessage 心跳、等令牌）；
 * 2) 弹窗侧 window.opener（回调页扫码成功后向原页面回传令牌）；
 * 3) window.close()（登录完成自关弹窗）。
 * deny + 转内置标签会把三条全切断：页面拿到 null 引用（后续 postMessage 抛
 * TypeError）、弹窗没有 opener 永远「等待客户端」、close() 也关不掉标签，
 * 表现为原页面卡「正在登录」。回调页与原页面通常跨源，postMessage 是唯一
 * 令牌通道，cookie/localStorage 共享救不回来。
 *
 * 判据（Electron 43 探针实测，非文档臆断）：带窗口特征的 window.open 给
 * disposition='new-window' + features='width=600,height=700,...'（无 new-popup
 * 枚举）；无特征 window.open 给 'foreground-tab'。故弹窗意图 =
 * new-window 且特征串含窗口定位 token（宽高/top/left 等；noopener/noreferrer
 * 这类无窗形特征不算）。目标语义与真 Chrome 一致：弹窗形态开原生窗口
 * （自动继承 guest 的 persist:browser 会话，opener/postMessage/close 完整），
 * 其余仍走内置新标签。原生弹窗必须源于真实用户手势（防脚本弹窗滥用）；
 * 无手势的弹窗形态维持既有转标签行为，不引入新的静默拦截。
 */
export type WindowOpenRouting = { kind: 'native-popup' } | { kind: 'in-app-tab' };

/** 特征串里指向“弹窗窗口形态”的 token（Chromium WebWindowFeatures 语义） */
const WINDOWING_FEATURE = /(?:^|,)\s*(?:popup|width|innerwidth|outerwidth|height|innerheight|outerheight|left|screenx|top|screeny|x|y)\b/i;

/** 弹窗形态 + 用户手势 → 原生弹窗；其余一律内置新标签 */
export function routeWindowOpen(disposition: string, features: string, userGesture: boolean): WindowOpenRouting {
  const popupIntent = disposition === 'new-popup' ||
    (disposition === 'new-window' && WINDOWING_FEATURE.test(String(features ?? '')));
  if (popupIntent && userGesture) return { kind: 'native-popup' };
  return { kind: 'in-app-tab' };
}
