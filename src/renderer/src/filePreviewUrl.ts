import { isWebGateway } from './webGatewayEnvironment';
import { MUSTER_APP_SCHEME, MUSTER_EXT_SCHEME, MUSTER_WS_SCHEME } from '../../shared/protocolSchemes';

/** 桌面协议地址与 Web 字节路由共用身份/查询参数。 */
export function filePreviewUrl(url: string): string {
  if (!isWebGateway()) return url;
  const parsed = new URL(url);
  if (parsed.protocol === `${MUSTER_WS_SCHEME}:`) return `/media/ws/${parsed.host}${parsed.pathname}${parsed.search}`;
  if (parsed.protocol === `${MUSTER_EXT_SCHEME}:`) return `/media/ext${parsed.pathname}`;
  if (parsed.protocol === `${MUSTER_APP_SCHEME}:`) return `/media/extension/${parsed.host}/view${parsed.pathname}${parsed.search}`;
  return url;
}
