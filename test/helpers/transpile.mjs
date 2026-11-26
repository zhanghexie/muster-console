/**
 * 自测用的极简 TS→ESM 打包器：从入口出发跟着相对 import 递归转译，
 * 在临时目录里按 `src/` 的相对路径镜像出 `.mjs`。
 *
 * 存在的理由：以前每个测试都手写一串 emit(...) 罗列依赖，主进程代码新加一个
 * import 就有测试报 ERR_MODULE_NOT_FOUND——那不是回归，只是清单没跟上。
 *
 * 放在 helpers/ 子目录：test/run.mjs 只扫 test/ 顶层的 *.mjs，不会把它当用例跑。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 纯类型 import/export 在运行期没有对应导出，转译前整行删掉 */
const TYPE_ONLY = /(?:import|export)\s+type\s+(?:\{[^}]*\}|[\w$]+)\s+from\s+'[^']+';?\r?\n/g;
/** 相对 specifier：`from './x'` 与 `import('./x')` */
const RELATIVE_SPECIFIER = /(from\s+|import\s*\(\s*)'(\.[^']*)'/g;

/**
 * @param outDir  产物根目录（镜像 src/ 结构）
 * @param root    仓库根
 * @param ts      typescript 模块
 * @param compilerOptions  transpileModule 选项
 * @param entryRel 入口相对仓库根的路径，如 'src/main/extensions/service.ts'
 * @returns 入口产物的绝对路径
 */
export function emitTree(outDir, root, ts, compilerOptions, entryRel) {
  const srcRoot = path.join(root, 'src');
  const done = new Set();

  const emitOne = (absTs) => {
    const rel = path.relative(srcRoot, absTs);
    if (done.has(rel)) return;
    done.add(rel);

    const source = fs.readFileSync(absTs, 'utf-8').replace(TYPE_ONLY, '');
    const deps = [];
    const rewritten = source.replace(RELATIVE_SPECIFIER, (_m, head, spec) => {
      deps.push(spec);
      return `${head}'${spec}.mjs'`;
    });

    const { outputText } = ts.transpileModule(rewritten, { compilerOptions, fileName: absTs });
    const outPath = path.join(outDir, rel.replace(/\.ts$/, '.mjs'));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, outputText, 'utf-8');

    for (const spec of deps) {
      emitOne(path.resolve(path.dirname(absTs), `${spec}.ts`));
    }
  };

  const entryAbs = path.join(root, entryRel);
  emitOne(entryAbs);
  return path.join(outDir, path.relative(srcRoot, entryAbs).replace(/\.ts$/, '.mjs'));
}
