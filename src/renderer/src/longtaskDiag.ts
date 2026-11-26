/**
 * 长任务诊断环形缓冲（P1-3）：PerformanceObserver('longtask') 观测 >1s 的长任务，
 * 记录 {start, duration, 活跃会话摘要, performance.memory} 入环形缓冲（封顶 20 条、
 * 脱敏：只记会话 id 尾段+名称，绝不落消息正文）。连续/累计 >2s 经既有
 * reportRendererError 落盘（不新增 IPC）。诊断性收益：冻结复发即有现场（时长/
 * 内存/会话上下文），把「未归因」变可归因。回滚=main.tsx 摘除 initLongtaskDiag()。
 */

const RING_CAP = 20;
/** 入环形缓冲门槛：>1s 才算可疑长任务 */
const RECORD_THRESHOLD_MS = 1000;
/** 落盘门槛：连续两条 >2s，或 >1s 任务累计 >2s */
const REPORT_THRESHOLD_MS = 2000;

export interface LongtaskRecord {
  /** 相对页面启动的开始时刻（performance.now 语义） */
  start: number;
  duration: number;
  /** 活跃会话摘要（id 尾段+名称），无活跃会话为 null；脱敏不含消息正文 */
  session: string | null;
  /** performance.memory 摘要（Chromium 专属；缺失为 null） */
  memory: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } | null;
}

const ring: LongtaskRecord[] = [];
let sessionSummary: string | null = null;
/** >1s 长任务的未落盘累计时长 */
let pendingOverMs = 0;

/** 诊断挂载点接线（中央面板活跃会话变化时更新摘要；脱敏由调用方负责截短） */
export function setLongtaskSessionSummary(summary: string | null): void {
  sessionSummary = summary;
}

/** 测试专用：只读环形缓冲（非语义面，不供业务用） */
export function longtaskRecordsForTest(): readonly LongtaskRecord[] {
  return ring;
}

/** 测试专用：清空缓冲与计数（用例隔离） */
export function resetLongtaskDiagForTest(): void {
  ring.length = 0;
  pendingOverMs = 0;
  sessionSummary = null;
}

export interface LongtaskDeps {
  memory: () => { usedJSHeapSize?: number; jsHeapSizeLimit?: number } | null;
  report: (label: string, message: string) => void;
}

/** 处理单条 longtask 观测：>1s 入环形缓冲；>1s 任务累计 >2s（单条 >2s 立即越限）
 *  走 report 落盘（冻结级事件即有现场），落盘后累计清零 */
export function recordLongtask(start: number, duration: number, deps: LongtaskDeps): void {
  if (duration <= RECORD_THRESHOLD_MS) return;
  pendingOverMs += duration;
  const record: LongtaskRecord = {
    start: Math.round(start),
    duration: Math.round(duration),
    session: sessionSummary,
    memory: deps.memory()
  };
  ring.push(record);
  if (ring.length > RING_CAP) ring.shift();
  if (pendingOverMs > REPORT_THRESHOLD_MS) {
    const last = ring[ring.length - 1]!;
    deps.report(
      'longtask.freeze',
      `长任务 ${Math.round(duration)}ms（累计未落盘 ${Math.round(pendingOverMs)}ms，` +
        `会话 ${last.session ?? '无'}，heap ${last.memory?.usedJSHeapSize ?? '?'}B）`
    );
    pendingOverMs = 0;
  }
}

/** main.tsx boot 链挂载点：longtask 观测（浏览器不支持时静默跳过） */
export function initLongtaskDiag(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordLongtask(entry.startTime, entry.duration, {
          memory: () => {
            const mem = (
              performance as unknown as {
                memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
              }
            ).memory;
            return mem
              ? { usedJSHeapSize: mem.usedJSHeapSize, jsHeapSizeLimit: mem.jsHeapSizeLimit }
              : null;
          },
          report: (label, message) => {
            void window.api?.app?.reportRendererError?.({ label, message });
          }
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch (err) {
    console.debug('[longtask-diag] PerformanceObserver 不可用，跳过:', err);
  }
}
