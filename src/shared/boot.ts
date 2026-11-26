/** 主进程后台启动链的结果（app:boot:wait 的返回值，主/渲染共用）。 */
export type BootResult = { ok: true } | { ok: false; error: string };
