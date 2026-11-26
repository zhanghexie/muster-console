import { protocol, session } from 'electron';
import path from 'node:path';
import {
  MUSTER_WS_SCHEME,
  MUSTER_ROOT_SCHEME,
  parseWorkspaceMediaUrl
} from '../shared/mediaKinds';
import { MUSTER_EXT_SCHEME, parseExternalFileUrl } from '../shared/filePreview';
import { MUSTER_APP_SCHEME, MUSTER_EXPORT_SCHEME } from '../shared/protocolSchemes';
import type { AppContext } from './context';
import { serveWorkspaceFile } from './workspaceFsServe';
import { withWorkspaceFileTarget, type WorkspaceFileTarget } from './workspaceFileAccess';

let registered = false;

/** 必须在 app.ready 之前调用 */
export function registerMetaAgentWsScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MUSTER_APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
    { scheme: MUSTER_EXPORT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
    { scheme: MUSTER_ROOT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
    {
      scheme: MUSTER_WS_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true
      }
    },
    {
      // 工作区外文件的只读服务（图片/音视频/PDF/office/归档预览）；URL 由渲染层
      // buildExternalFileUrl 生成，只接受绝对路径且仅 stat 通过的 regular file
      scheme: MUSTER_EXT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true
      }
    }
  ]);
}

/**
 * muster-ws://<workspaceId>/<rel> 的处理体（协议 handler 与 web 网关
 * /media/ws/* 路由共用）：schemeUrl 用于路径解析，request 携带 Range 等头。
 */
export async function handleWorkspaceMediaRequest(
  ctx: AppContext,
  schemeUrl: string,
  request: Request
): Promise<Response> {
  try {
    const { workspaceId, rootId, relativePath } = parseWorkspaceMediaUrl(schemeUrl);
    if (!relativePath) {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    }
    const target: WorkspaceFileTarget = rootId !== undefined ? { workspaceId, rootId, relativePath } : workspaceId;
    return await withWorkspaceFileTarget(() => ctx.config.get(), target, relativePath, async (_root, _ref, abs) => {
      const response = await serveWorkspaceFile(abs, request);
      if (schemeUrl.startsWith(`${MUSTER_ROOT_SCHEME}:`)) {
        const headers = new Headers(response.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(response.body, { status: response.status, headers });
      }
      return response;
    });
  } catch (err) {
    console.error('[muster-ws]', err);
    return new Response('Forbidden', { status: 403, statusText: 'Forbidden' });
  }
}

/**
 * muster-ext://f/<abs> 的处理体（协议 handler 与 web 网关 /media/ext/*
 * 路由共用）：工作区外文件只读服务，与 fs:readExternal 同一安全姿态，
 * 仅 serveWorkspaceFile 的 stat isFile 校验，无任何写路径。
 */
export async function handleExternalFileRequest(
  schemeUrl: string,
  request: Request
): Promise<Response> {
  try {
    const parsed = parseExternalFileUrl(schemeUrl);
    if (!parsed || !path.isAbsolute(parsed.absPath)) {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    }
    return await serveWorkspaceFile(path.resolve(parsed.absPath), request);
  } catch (err) {
    console.error('[muster-ext]', err);
    return new Response('Forbidden', { status: 403, statusText: 'Forbidden' });
  }
}

/** app.ready 之后注册 handler */
export function registerMetaAgentWsProtocol(ctx: AppContext): void {
  if (registered) return;
  registered = true;
  // Only browser guests may navigate exported documents. Each export has its own origin.
  session.fromPartition('persist:browser').protocol.handle(MUSTER_EXPORT_SCHEME, request =>
    ctx.extensionSystem?.exports.servePreview(request) ?? new Response('Not Found', { status: 404 }));
  // Electron's protocol.handle path can return the top-level panel HTML while
  // rejecting its iframe subresources with ERR_UNEXPECTED. The buffer adapter
  // preserves relative CSS/JS/module loading on supported Electron versions.
  protocol.registerBufferProtocol(MUSTER_APP_SCHEME, (request, callback) => {
    const range = request.headers?.range ?? request.headers?.Range;
    const webRequest = new Request(request.url, { method: request.method, ...(range ? { headers: { range } } : {}) });
    const resource = ctx.extensionSystem?.extensionHost.resource(webRequest) ?? new Response('Extension host unavailable', { status: 503 });
    void Promise.resolve(resource).then(async response => {
      const responseForExtension = response.status === 403 ? await Promise.resolve(ctx.extensionSystem?.extensionHost.resource(webRequest)) ?? response : response;
      const headers: Record<string, string> = {};
      responseForExtension.headers.forEach((value, key) => { headers[key] = value; });
      callback({ statusCode: responseForExtension.status, headers, data: responseForExtension.body ? Buffer.from(await responseForExtension.arrayBuffer()) : Buffer.alloc(0) });
    }, error => {
      console.error('[muster-app]', request.url, error);
      callback({ statusCode: 500, data: Buffer.from('Extension workbench unavailable') });
    });
  });

  protocol.handle(MUSTER_WS_SCHEME, (request) =>
    handleWorkspaceMediaRequest(ctx, request.url, request)
  );
  protocol.handle(MUSTER_ROOT_SCHEME, request => handleWorkspaceMediaRequest(ctx, request.url, request));

  // 工作区外文件只读服务
  protocol.handle(MUSTER_EXT_SCHEME, (request) => handleExternalFileRequest(request.url, request));
}
