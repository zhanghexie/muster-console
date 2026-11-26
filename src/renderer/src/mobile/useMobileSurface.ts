/**
 * 手机端表面判定（mobile-remote-interaction-plan）：浏览器打开且是手机类设备
 * （移动 UA，或触摸主指针 + 窄视口）时渲染 MobileApp 三级页面栈；桌面壳与
 * 桌面窄窗口（鼠标主指针）继续走原有抽屉布局（responsive.css），两套互不干扰。
 *
 * 判定在**页面加载时锁定**、会话内不再重算：中途切换只会两棵树整卸整挂，
 * resize 跨过 820px 时闪现另一表面（桌面闪手机壳/手机闪桌面布局），得不偿失；
 * 真机上 UA 不会变，需要切换的场景只有 devtools 模拟——刷新页面即可。
 */
import { useState } from 'react';

const MOBILE_UA_RE = /Android|iPhone|iPad|iPod|Windows Phone|IEMobile|Mobile|HarmonyOS/i;

function computeLocked(): boolean {
  if (typeof window === 'undefined') return false;
  // e2e / 调试：刷新前写入即可强制手机表面（加载时锁定）
  try {
    if (sessionStorage.getItem('muster.mobile.force') === '1') return true;
  } catch {
    /* ignore */
  }
  if (MOBILE_UA_RE.test(navigator.userAgent)) return true;
  // 触摸主指针 + 窄视口（平板 / 触屏模拟器）；鼠标窄窗口不进手机路由
  return (
    window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(max-width: 820px)').matches
  );
}

/** 是否进入手机端表面（首次挂载锁定；换表面刷新页面） */
export function useMobileSurface(): boolean {
  return useState(computeLocked)[0];
}

/** 非 hook 场景读锁定值（如入口快速分流） */
export function mobileSurfaceLocked(): boolean {
  return computeLocked();
}
