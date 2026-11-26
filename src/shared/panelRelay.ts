/**
 * 沙箱 iframe 中键与焦点中继：iframe（扩展面板/HTML 预览）是跨源 guest 文档，
 * 鼠标事件不进宿主文档，宿主的 document 级中键监听（全局看板开关）收不到，
 * Electron 也不给 OOPIF 暴露 webContents——只能由 guest 自己捕获中键
 * postMessage 回宿主（App.tsx 处理中键，CenterPanel 按实际 iframe 来源处理焦点）。
 * 注入点：muster-ws 协议对扩展面板 HTML（workspaceFsProtocol）、
 * HTML 预览 srcDoc（FileEditor）。PDF 预览是原生查看器，不注入。
 * 选区中继同因：宿主 getSelection() 看不到 guest 内的划词，
 * SelectionMenuHost 按 iframe 位置换算锚点后展示全局划词菜单。
 */
export const PANEL_FOCUS_EVENT = 'panelFocus';
export const PANEL_SELECTION_EVENT = 'panelSelection';
export const PANEL_CLEAR_SELECTION_EVENT = 'panelClearSelection';
export const PANEL_ESCAPE_EVENT = 'panelEscape';

export const PANEL_MIDDLE_CLICK_RELAY =
  '<script>(function(){var reportFocus=function(){parent.postMessage({__ma:true,type:"' + PANEL_FOCUS_EVENT + '"},"*");};' +
  'document.addEventListener("pointerdown",reportFocus,true);document.addEventListener("focusin",reportFocus,true);' +
  'window.addEventListener("focus",reportFocus);document.addEventListener("mousedown",function(e){' +
  'if(e.button===1&&!e.defaultPrevented){e.preventDefault();' +
  'parent.postMessage({__ma:true,type:"middleClick"},"*");}},true);' +
  'document.addEventListener("keydown",function(e){if(e.key==="Escape")parent.postMessage({__ma:true,type:"' + PANEL_ESCAPE_EVENT + '"},"*");},true);' +
  'document.addEventListener("mouseup",function(e){if(e.button!==0)return;var s=document.getSelection();' +
  'var t=s?String(s):"";parent.postMessage({__ma:true,type:"' + PANEL_SELECTION_EVENT + '",' +
  'text:t.slice(0,8000),x:e.clientX,y:e.clientY},"*");},true);' +
  'window.addEventListener("message",function(e){var d=e.data;if(e.source===parent&&d&&d.__ma===true&&' +
  'd.type==="' + PANEL_CLEAR_SELECTION_EVENT + '"){var s=document.getSelection();if(s)s.removeAllRanges();}});})();</script>';

/** 把中继脚本插到 <head> 之后；无 <head> 时置于文档最前 */
export function injectPanelRelay(html: string): string {
  const m = html.match(/<head[^>]*>/i);
  if (m && m.index !== undefined) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + PANEL_MIDDLE_CLICK_RELAY + html.slice(at);
  }
  return PANEL_MIDDLE_CLICK_RELAY + html;
}

/** Extension canvases are drawing surfaces; avoid a large browser focus rectangle. */
export function injectExtensionPanelChrome(html: string): string {
  const style = '<style data-ma-canvas-focus>canvas:focus { outline: none !important; }</style>';
  const relayed = injectPanelRelay(html);
  const head = relayed.match(/<head[^>]*>/i);
  if (!head || head.index === undefined) return style + relayed;
  const at = head.index + head[0].length;
  return relayed.slice(0, at) + style + relayed.slice(at);
}
