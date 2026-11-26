/**
 * B2 合同拆轨编译期锁（docs/plans/driver-contract-v2.md §6）：
 * - 三轨（DTO / 回调 RPC / 活对象）互不重叠；
 * - 并集覆盖 GuiDriverConnectInput 全部字段（新增字段未归轨即编译红）；
 * - DTO fixture 是纯 JSON 形态（可过线）。
 * 运行: vitest（test/unit）
 */
import { describe, expect, it } from 'vitest';
import type {
  GuiDriverCallbackRpc,
  GuiDriverConnectDto,
  GuiDriverConnectInput,
  GuiDriverLiveObjects
} from '../../src/main/agentSession/types';

type AssertNever<T extends never> = T;

// ① 三轨互不重叠：DTO 里不得残留任何回调键或活对象键
type DtoLeak = Extract<
  keyof GuiDriverConnectDto,
  keyof GuiDriverCallbackRpc | keyof GuiDriverLiveObjects
>;
type _NoDtoLeak = AssertNever<DtoLeak>;

// ② 并集覆盖：connect input 的每个字段都归了轨（漏一个 → MissingKeys 非 never → 编译红）
type MissingTracks = Exclude<
  keyof GuiDriverConnectInput,
  keyof GuiDriverConnectDto | keyof GuiDriverCallbackRpc | keyof GuiDriverLiveObjects
>;
type _NoMissingTracks = AssertNever<MissingTracks>;

// ③ 回调轨键面精确锁定（多列/少列一个键都会编译红）
const callbackKeys = [
  'requestApproval',
  'requestUserQuestion',
  'getPolicyState',
  'getTurnId',
  'getDesktopTurnId',
  'getThinkingLevel',
  'log'
] as const satisfies ReadonlyArray<keyof GuiDriverCallbackRpc>;
type _NoMissingCallbacks = AssertNever<Exclude<keyof GuiDriverCallbackRpc, typeof callbackKeys[number]>>;
const liveKeys: Array<keyof GuiDriverLiveObjects> = ['modeController', 'hostTools'];

describe('B2 driver 合同拆轨', () => {
  it('DTO fixture 是纯 JSON 形态（跨过线往返无损）', () => {
    const dto = {
      sessionId: 's1',
      cwd: 'C:/repo',
      systemPromptAppend: '政策层',
      mode: 'auto',
      planExecuting: false,
      permissionMode: 'auto',
      resumeToken: 'tok',
      seedSource: { directory: '/private/fork-context', descriptor: { version: 1, ownerSessionId: 's1', name: 's1.seeds.ndjson', count: 1, sha256: 'a'.repeat(64) } },
      guards: { bashDeny: ['rm -rf'] }
    } satisfies GuiDriverConnectDto;
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  });

  it('回调/活对象键面与合同文档一致', () => {
    expect(callbackKeys).toHaveLength(7);
    expect(liveKeys).toHaveLength(2);
  });

  it('回调键不得作为 DTO 字段出现（负例：类型拒绝）', () => {
    // 编译期已由 _NoDtoLeak 断言；运行期用运行对象佐证 DTO 形状不含函数
    const dto = {
      sessionId: 's1',
      cwd: 'C:/repo',
      systemPromptAppend: '',
      mode: 'auto',
      planExecuting: false,
      permissionMode: 'auto'
    } satisfies GuiDriverConnectDto;
    expect(Object.values(dto).every((v) => typeof v !== 'function')).toBe(true);
  });
});
