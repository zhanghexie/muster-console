/**
 * 开发自测用 Mock LLM 服务（OpenAI 兼容 /chat/completions，流式）。
 *
 * 仅用于验证「流式解析 → tool-call → executor → 结果回填」整条管线，
 * 不是产品的 Agent 后端（产品必须接真实 LLM）。
 *
 * 协议：
 * - 用户消息形如 `tool:<api_name> {json args}` → 第一轮返回该 tool_call；
 *   工具结果回填后第二轮返回文本总结。
 * - 其它消息 → 直接流式回显文本。
 *
 * 用法：node test/mock-llm.mjs（默认端口 18034），
 * 设置里 baseUrl 填 http://127.0.0.1:18034/v1，apiKey 随意，model 随意。
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT || 18034);

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunkOf(delta, finish = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }]
  };
}

const server = http.createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    const messages = payload.messages ?? [];
    const last = messages[messages.length - 1] ?? {};
    // content 兼容 string 与 content blocks 数组（pi-ai 等客户端走数组形状）
    const lastText =
      typeof last.content === 'string'
        ? last.content
        : Array.isArray(last.content)
          ? last.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
          : '';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const streamText = (text) => {
      for (const ch of text.match(/.{1,8}/gs) ?? []) {
        sse(res, chunkOf({ content: ch }));
      }
      sse(res, chunkOf({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    };

    // 工具结果回填后的轮次 → 文本总结
    if (last.role === 'tool') {
      const ok = /"ok":true/.test(lastText);
      streamText(`【mock】工具执行${ok ? '成功' : '失败/取消'}，结果片段：${lastText.slice(0, 160)}`);
      return;
    }

    const text = lastText.trim();
    // 宿主会在首条用户消息前注入态势快照/系统提醒等上下文，指令可能不再位于消息开头：
    // 按最后一处「行首 tool:」识别，其后整体视为 args
    const directiveAt = text.lastIndexOf('\ntool:');
    const directive = directiveAt >= 0 ? text.slice(directiveAt + 1) : text;
    // 工具名允许点号与连字符（扩展 agent 工具形如 ext_rubiks-cube_command_cube_move）
    const m = directive.match(/^tool:([A-Za-z0-9_.-]+)\s*(\{[\s\S]*\})?$/);
    if (m) {
      const args = m[2] ?? '{}';
      sse(res, chunkOf({ tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: m[1], arguments: '' } }] }));
      for (const piece of args.match(/.{1,10}/gs) ?? ['{}']) {
        sse(res, chunkOf({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
      }
      sse(res, chunkOf({}, 'tool_calls'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    streamText(`【mock】收到：${text}（这是 mock 后端，仅用于管线自测；请在设置里接入真实 LLM）`);
  });
});

server.listen(PORT, () => {
  console.log(`mock LLM listening on http://127.0.0.1:${PORT}/v1/chat/completions`);
});
