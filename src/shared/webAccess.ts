/**
 * 网页访问（远程连接 · 网址连接）共享类型：设置页「远程连接」与主进程网关的契约。
 */

/** webhook 触发端点信息（T3.2，设置页展示 hook 地址与签名密钥） */
export interface WebAccessHookInfo {
  /** hook 路径（含 hook token），如 `/hook/ab12…`；未启用时为空串 */
  path: string;
  /** 可用的完整 hook 地址（每个网卡一个，含 hook token）；第一个为推荐地址 */
  urls: string[];
  /**
   * GitHub 签名密钥（展示给用户填入 webhook 的 Secret）；空串 = 未启用签名校验。
   * 这是可被用户替换的共享密钥，与网页访问 token 相互独立。
   */
  secret: string;
  /** 是否启用签名校验（secret 非空） */
  signatureEnabled: boolean;
}

export interface WebAccessStatusInfo {
  /** 网关是否已启动（MUSTER_WEB=0 或启动失败时为 false） */
  running: boolean;
  port: number;
  /** 当前生效的 token（持久保存，重启不变；仅点「重新生成」后变化） */
  token: string;
  /** 可用的完整连接地址（含 token），第一个为推荐地址（局域网 IP 优先，缺省 127.0.0.1） */
  urls: string[];
  /** 推荐地址的二维码 dataURL（running=false 时为空串） */
  qrDataUrl: string;
  /** 未启动原因（未开启开关 / 端口被占等），running=false 时展示 */
  disabledReason: string;
  /** webhook 触发端点（T3.2） */
  hook: WebAccessHookInfo;
}

/** 网关自身返回的状态（不含渲染进程按需生成的二维码） */
export type WebAccessStatusBase = Omit<WebAccessStatusInfo, 'qrDataUrl'>;
