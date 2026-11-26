# clientMode 契约与 task-run 租约（client-mode-lease）

> ZCode 借鉴 · 批次 D3（2026-09-26 落地）：hello 强校验 + owner/lease 词表与互斥纯函数。
> **先立契约，不实现全链路 relay**（fork/完整多端中继后置）。

## 功能职责

- **clientMode 投递分型**：接入端 hello 声明 `clientMode: desktop-continuous | web-remote-replayable`，
  并**必须**携带匹配的 `deliveryProfile`（strict 配对，不静默纠正）：
  - `desktop-continuous` ↔ `continuous`（桌面常驻连接、事件流连续；断线靠 sync 全量对账，无需回放）
  - `web-remote-replayable` ↔ `replayable`（远端可回放；从 cursor/offset 补洞，`stream_mirror_gap` 可恢复）
- **task-run owner/lease 词表**：同一 task-run 同一时刻至多一个 owner。
  - 操作词：`acquire` / `release`
  - 事件词：`stream_mirror_gap`（镜像端流序号缺口）、`owner_lost`（持有者租约过期/失联）
- 手机远控**复用**桌面 Host attachment，不另起 Agent（产品裁决，本模块只落契约面）。

## 关键文件与入口

| 文件 | 职责 |
|------|------|
| `src/shared/clientMode.ts` | 全部纯函数契约：`validateClientHello`（hello 强校验）、`CLIENT_MODE_DELIVERY` 配对表、lease 互斥（`acquireTaskRunLease`/`releaseTaskRunLease`）、`detectOwnerLost`、`classifyStreamMirrorGap`。零依赖，test/*.mjs 即时转译导入 |
| `test/client-mode.mjs` | 回归：hello 合法配对/六类拒绝码、lease 互斥（首占/续租/他主拒绝/过期 reclaim/仅持有者 release）、词表事件判定 |

## 契约要点

1. **hello 强校验**（`validateClientHello`）拒绝码：
   `not_object` / `missing_client_mode` / `unknown_client_mode` /
   `missing_delivery_profile` / `unknown_delivery_profile` / `delivery_mismatch`。
   `deliveryProfile` **必填**且必须命中配对表——缺省、未知、不匹配一律拒绝。
2. **lease 互斥**（`acquireTaskRunLease`）：
   - 同主重入 = 续租（刷新 `acquiredAt`/`leaseMs`）；
   - 他主未过期 → `held_by_other`（互斥）；
   - 他主已过期 → 允许 reclaim，返回 `reclaimed: true` + `evictedOwner`（owner_lost 语义）；
   - `release` 仅持有者本人成功，他人/已释放为 no-op。
   - 缺省租约 `DEFAULT_TASK_RUN_LEASE_MS` = 15 分钟（对齐 turnGate 口径）。
3. **镜像缺口**（`classifyStreamMirrorGap`）：仅非持有者（mirror）可能缺口；
   序号连续无缺口；缺口时 `replayable` 可回放补洞（`recoverable: true`），
   `continuous` 补不了。

## 已知边界

- 全链路 relay（事件转发/多端 attach/手机复用 Host）**未实现**，本模块只提供词表与纯函数；
  接线点待多端接入时再挂（web-access hello 通道是候选宿主）。
- **接线冲突待裁定（新旧两套 hello 契约缺省姿态相反）**：现行 ws 协议 `wsProtocol.HelloFrame` = `{t:'hello', caps}`，`caps` **缺省=全量、未声明即保持旧行为**（向后兼容旧客户端的现行服务端姿态）；而本模块 `validateClientHello` 要求 `{clientMode, deliveryProfile}` **缺失即拒绝**（strict，不静默纠正）。两种缺省姿态相反——将来在 web-access hello 通道接入本契约时，必须先回答「旧客户端（只发 caps）与新字段如何共存」。建议方向：hello 帧扩展**可选** `clientMode` 字段，声明了才走 strict 校验，未声明保持旧行为；兼容策略属意图取舍，接线前须用户裁定。
- `TaskRunLeaseTable` 是内存 Map，不做持久化；崩溃后租约自然丢失（下次 acquire 重建）。
- `stream_mirror_gap` 只做分类判定，不负责补发/回放本身。

## 设计初衷（2026-10-26 与用户定稿）

> 依据 campaign-intent-drafts/D10-D14.md 草案定稿（用户 2026-10-26「不抽查直接定稿」）；歧义点处置：22 项卡片决策＋长尾按草案推荐，明细见专项账本「意图定稿决策」节。

- 为谁/什么场景：多端接入的契约面——hello 强校验（clientMode×deliveryProfile 严格配对不静默纠正）+ task-run owner/lease 互斥词表（acquire/release/owner_lost/stream_mirror_gap）；手机远控复用桌面 Host attachment（产品裁决）。
- 为什么这样设计：先立契约不实现全链路 relay——词表与纯函数先行（零依赖可即时测试），接线点待多端接入时挂（web-access hello 通道是候选宿主）；租约 15 分钟对齐 turnGate；镜像缺口只分类判定不负责补发。
- 明确不做：全链路 relay（事件转发/多端 attach/手机复用 Host）未实现；租约不持久化（崩溃即失，下次 acquire 重建）。
- 歧义点：契约先行后的全链路 relay——A=按需接线（多端真实需求出现再挂，review 只守契约测试活性、不催实施）／B=排期实现完整 relay。推荐 A——当前多端形态=web-access 直连已覆盖在用链路，relay 缺位不阻塞任何现有功能。
