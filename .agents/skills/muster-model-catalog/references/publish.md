# 模型目录发布与验证

## 检出并生成候选

在 Muster 源码根使用当前锁定依赖和既有 Git 认证。独立发布仓库是 [`zhanghexie/muster-model-catalog`](https://github.com/zhanghexie/muster-model-catalog)，以 `main` 的最新提交为基准。使用独立临时目录，避免周更任务占用本地其他工作。

```bash
catalog_run=$(mktemp -d)
GIT_TERMINAL_PROMPT=0 git clone --single-branch --branch main \
  git@github.com:zhanghexie/muster-model-catalog.git "$catalog_run/catalog"
curl --fail --silent --show-error --max-time 30 \
  'https://models.opencode.ai/experimental/v2.0/api.json?type=chat' \
  --output "$catalog_run/models-dev-chat.json"
node scripts/build-core-reasoning-catalog.mjs \
  --input "$catalog_run/models-dev-chat.json" \
  --official-capabilities "$catalog_run/catalog/data/model-capabilities.json" \
  --revision YYYY-MM-DD.N --output "$catalog_run/reasoning-v2.json"
```

上例的版本号按发布日期替换。先按端点身份比较候选和 `main` 上的 `models`、`capabilities` 与 `pi`。忽略版本、日期和对象键顺序；比较思考档时保留 `effort` 的顺序。核对 `contextWindow` 和 `input` 的变化与端点是否吻合。更新 `data/model-capabilities.json` 中通过厂商资料核验的规格，保留证据链接。上下游候选中有待核实的变化时沿用该条的生产值。删项要有厂商下线或明确更正依据。HTTP 异常、上游部分返回或内容无法验证时保留已发布文件。

有效数据变更后，把修改后的文件放到目录仓库的 `public/` 下。对每个有变更的文件单独递增 `YYYY-MM-DD.N`，同日续号，v1 同步更新 `updatedAt`。版本按北京时间计算。保留 v2 附带的 `public/reasoning-v2-licenses.txt`，上游来源或许可变化时同步更新声明。使用发行文件当前的序列化风格。

## 校验发行文件

在 Muster 源码根执行。目录仓库的校验是 Pages 的构建门禁，客户端解析器会再检查两种格式。下面把实际候选传给正式解析器，验证 schema、规范化后的身份唯一性、协议和值映射及 1 MiB／2 MiB 的下载上限。

```bash
(cd "$catalog_run/catalog" && node scripts/validate.mjs)
node --input-type=module - "$catalog_run/catalog/public" <<'JS'
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './test/helpers/shared-compile.mjs';

const directory = process.argv[2];
const scratch = await mkdtemp(join(tmpdir(), 'muster-catalog-verify-'));
try {
  const compile = createSharedCompiler(process.cwd(), scratch);
  const { parseCoreReasoningCatalog, parseExpandedReasoningCatalog } =
    await import(pathToFileURL(compile('main/agent/coreReasoningCatalog.ts')).href);
  for (const [file, limit, parse] of [
    ['v1/reasoning.json', 1024 * 1024, parseCoreReasoningCatalog],
    ['reasoning-v2.json', 2 * 1024 * 1024, parseExpandedReasoningCatalog]
  ]) {
    const payload = await readFile(join(directory, file));
    assert(payload.length <= limit, `${file} exceeds the client download limit`);
    const { revision, models, capabilities } = parse(JSON.parse(payload.toString('utf8')));
    if (file === 'reasoning-v2.json') assert(capabilities?.length, 'expected published input specifications');
    console.log(`${file} ${revision} (${models.length} reasoning entries, ${capabilities?.length ?? 0} input specifications)`);
  }
} finally {
  await rm(scratch, { force: true, recursive: true });
}
JS
```

有新增生成规则或值映射变更时，运行 `node test/core-reasoning-catalog.mjs` 和 `node test/core-reasoning-coverage.mjs`。这两个用例覆盖原生请求字段、离线缓存和已知端点。涉及客户端 UI 或协议变更时，按项目 `AGENTS.md` 补对应回归。

## 提交并确认生产

1. 复查目录仓库的 `git diff` 与 `git status`。将公共 JSON、改动的 `data/model-capabilities.json` 和相应许可文件一同提交。推送 `HEAD:refs/heads/main`。如果远端已前进，取最新 `main` 重新比较、校验再推送。使用普通快进推送。
2. Cloudflare Pages 项目 `muster-model-catalog` 连接该仓库的生产分支 `main`。构建预设为 `None`，根目录使用仓库根，构建命令为 `node scripts/validate.mjs`，输出目录为 `public`。推送即触发构建。 [Cloudflare Git 集成](https://developers.cloudflare.com/pages/get-started/git-integration/)
3. 等待生产部署后，从 [v1 JSON](https://muster-model-catalog.pages.dev/v1/reasoning.json)、[v2 JSON](https://muster-model-catalog.pages.dev/reasoning-v2.json) 和 [许可说明](https://muster-model-catalog.pages.dev/reasoning-v2-licenses.txt) 取回本次更新的文件。需要避开旧缓存时给公开 URL 加本次提交 SHA 的查询参数。核对 HTTP 200、发布版本、变更条目与仓库文件的内容。未确认生产版本时，报告 Git 提交与部署的实际状态。发现回归时，经发布授权可提交一次 `git revert` 并重新执行生产验证。
