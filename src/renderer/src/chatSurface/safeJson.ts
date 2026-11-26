/** JSON 美化兜底（工具参数/审批入参展示共用；解析失败回退 String()） */
export function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
