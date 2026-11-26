/**
 * bashReadonly 三态分类器（S2.3 / T4+T5）。
 * 运行: node test/bash-readonly.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-readonly-'));
const compile = createSharedCompiler(root, tmp);

const bashReadonlyOut = compile('shared/bashReadonly.ts');
const policyOut = compile('shared/guiWorkerPolicy.ts');
const { classifyBashReadonly } = await import(pathToFileURL(bashReadonlyOut).href);
const { decideToolPermission, isReadOnlyShellCommand } = await import(pathToFileURL(policyOut).href);

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}: ${e.message}`);
  }
};

check('反例拦截：sed -i/w 等危险 flag → false', () => {
  assert.equal(classifyBashReadonly('sed -i s/a/b/ file'), 'false');
  assert.equal(classifyBashReadonly('sed --in-place s/a/b/ file'), 'false');
  assert.equal(classifyBashReadonly("sed 'w output.txt' file"), 'false');
  assert.equal(classifyBashReadonly('sed -n -i s/a/b/ file'), 'false');
});

check('反例拦截：find -delete/-exec → false', () => {
  assert.equal(classifyBashReadonly('find . -delete'), 'false');
  assert.equal(classifyBashReadonly('find . -exec rm {} \\;'), 'false');
  assert.equal(classifyBashReadonly('find . -execdir ls {} \\;'), 'false');
  assert.equal(classifyBashReadonly('find . -ok rm {} \\;'), 'false');
});

check('反例拦截：jq env/import → false', () => {
  assert.equal(classifyBashReadonly('jq env'), 'false');
  assert.equal(classifyBashReadonly("jq 'env'"), 'false');
  assert.equal(classifyBashReadonly("jq 'import \"foo\" as f; f'"), 'false');
});

check('反例拦截：printf 八进制 → false', () => {
  assert.equal(classifyBashReadonly('printf "\\101"'), 'false');
  assert.equal(classifyBashReadonly("printf '\\101'"), 'false');
  assert.equal(classifyBashReadonly('printf "\\033[0m"'), 'false');
});

check('反例拦截：xargs 目标表 → false', () => {
  assert.equal(classifyBashReadonly('xargs rm'), 'false');
  assert.equal(classifyBashReadonly('xargs -I {} rm {}'), 'false');
});

check('反例拦截：git 危险全局 flag → false', () => {
  assert.equal(classifyBashReadonly('git -c core.sshCommand=evil status'), 'false');
  assert.equal(classifyBashReadonly('git --exec-path=/tmp/evil status'), 'false');
  assert.equal(classifyBashReadonly('git --git-dir=/tmp/evil status'), 'false');
});

check('反例拦截：写命令/危险重定向/命令替换 → false', () => {
  assert.equal(classifyBashReadonly('rm -rf /'), 'false');
  assert.equal(classifyBashReadonly('mv a b'), 'false');
  assert.equal(classifyBashReadonly('cat file > output.txt'), 'false');
  assert.equal(classifyBashReadonly('cat $(evil)'), 'false');
  assert.equal(classifyBashReadonly('cat `evil`'), 'false');
  assert.equal(classifyBashReadonly('cat <(evil)'), 'false');
});

check('只读放行：ls/cat 等 → true', () => {
  assert.equal(classifyBashReadonly('ls'), 'true');
  assert.equal(classifyBashReadonly('ls -la'), 'true');
  assert.equal(classifyBashReadonly('cat file.txt'), 'true');
  assert.equal(classifyBashReadonly('grep foo file.txt'), 'true');
  assert.equal(classifyBashReadonly('wc -l file'), 'true');
  assert.equal(classifyBashReadonly('head -n 10 file'), 'true');
  assert.equal(classifyBashReadonly('tail -f file'), 'true');
  assert.equal(classifyBashReadonly('pwd'), 'true');
  assert.equal(classifyBashReadonly('echo hello'), 'true');
  assert.equal(classifyBashReadonly('stat file'), 'true');
});

check('只读放行：sed -n / find / jq / printf / git → true', () => {
  assert.equal(classifyBashReadonly('sed -n "p" file'), 'true');
  assert.equal(classifyBashReadonly('sed -n "1,3p" file'), 'true');
  assert.equal(classifyBashReadonly('find . -name "*.ts"'), 'true');
  assert.equal(classifyBashReadonly('find . -type f'), 'true');
  assert.equal(classifyBashReadonly('jq ".foo" file.json'), 'true');
  assert.equal(classifyBashReadonly('printf "hello"'), 'true');
  assert.equal(classifyBashReadonly('printf "%d\\n" 42'), 'true');
  assert.equal(classifyBashReadonly('git status'), 'true');
  assert.equal(classifyBashReadonly('git diff'), 'true');
  assert.equal(classifyBashReadonly('git log --oneline'), 'true');
  assert.equal(classifyBashReadonly('git show HEAD'), 'true');
  assert.equal(classifyBashReadonly('git branch'), 'true');
  assert.equal(classifyBashReadonly('git remote -v'), 'true');
});

check('只读放行：xargs/env 目标只读 → true', () => {
  assert.equal(classifyBashReadonly('xargs ls'), 'true');
  assert.equal(classifyBashReadonly('xargs wc -l'), 'true');
  assert.equal(classifyBashReadonly('env'), 'true');
  assert.equal(classifyBashReadonly('env FOO=bar'), 'true');
  assert.equal(classifyBashReadonly('env FOO=bar cat file'), 'true');
});

check('只读放行：/dev/null 重定向 → true', () => {
  assert.equal(classifyBashReadonly('cat file 2>/dev/null'), 'true');
  assert.equal(classifyBashReadonly('grep foo file > /dev/null'), 'true');
  assert.equal(classifyBashReadonly('ls 2>&1'), 'true');
});

check('unknown 走确认：不在白名单 → unknown', () => {
  assert.equal(classifyBashReadonly('foo --bar'), 'unknown');
  assert.equal(classifyBashReadonly('npm test'), 'unknown');
  assert.equal(classifyBashReadonly('docker ps'), 'unknown');
  assert.equal(classifyBashReadonly('myScript.sh'), 'unknown');
  assert.equal(classifyBashReadonly(''), 'unknown');
});

check('unknown 走确认：git 未知子命令 → unknown', () => {
  assert.equal(classifyBashReadonly('git push'), 'unknown');
  assert.equal(classifyBashReadonly('git commit -m "x"'), 'unknown');
  assert.equal(classifyBashReadonly('git'), 'unknown');
});

check('管道组合：每段 true 才 true', () => {
  assert.equal(classifyBashReadonly('ls | cat'), 'true');
  assert.equal(classifyBashReadonly('ls | cat | grep foo'), 'true');
  assert.equal(classifyBashReadonly('cat file | wc -l'), 'true');
  assert.equal(classifyBashReadonly('ls; cat file'), 'true');
  assert.equal(classifyBashReadonly('ls && cat file'), 'true');
  assert.equal(classifyBashReadonly('ls || cat file'), 'true');
});

check('管道组合：含 false 段 → false', () => {
  assert.equal(classifyBashReadonly('ls | sed -i s/a/b/'), 'false');
  assert.equal(classifyBashReadonly('sed -i file | ls'), 'false');
  assert.equal(classifyBashReadonly('ls && rm file'), 'false');
  assert.equal(classifyBashReadonly('ls | find . -delete'), 'false');
});

check('管道组合：含 unknown 段（无 false）→ unknown', () => {
  assert.equal(classifyBashReadonly('ls | foo'), 'unknown');
  assert.equal(classifyBashReadonly('foo | ls'), 'unknown');
  assert.equal(classifyBashReadonly('ls && npm test'), 'unknown');
  assert.equal(classifyBashReadonly('cat file | unknown | wc -l'), 'unknown');
});

check('审批门接线：default 壳自动执行，ask 模式仍阻止写入和未知命令', () => {
  const ids = [];
  const hostClassOf = () => 'status';
  const decide = (cmd, mode = 'default') =>
    decideToolPermission({
      mode,
      planExecuting: false,
      permissionClass: 'shell',
      shellCommand: cmd,
      pathInsideRoot: null,
      mcpReadOnly: false
    });
  assert.equal(decide('ls -la'), 'auto');
  assert.equal(decide('cat file.txt'), 'auto');
  assert.equal(decide('git status'), 'auto');
  assert.equal(decide('ls | cat'), 'auto');
  for (const command of ['sed -i s/a/b/ f', 'rm -rf /', 'foo --bar', 'npm test', 'ls | sed -i s/a/b/', 'ls | foo']) {
    assert.equal(decide(command), 'auto');
    assert.equal(decide(command, 'ask'), 'deny');
  }
});

// ── 对抗性回归（2026-09-27 复审：default 模式 auto 放行面的绕过样本） ──

check('对抗：awk 写/执行 → false（action 块内 > | system）', () => {
  assert.equal(classifyBashReadonly(`awk 'BEGIN{system("rm -rf /tmp/pwn")}'`), 'false');
  assert.equal(classifyBashReadonly(`awk '{print > "/tmp/pwn.txt"}' f`), 'false');
  assert.equal(classifyBashReadonly(`awk '{print | "sort"}' f`), 'false');
  assert.equal(classifyBashReadonly('awk \'{print $1}\' file'), 'true');
  assert.equal(classifyBashReadonly('awk \'{sum += $1} END {print sum}\' f'), 'true');
});

check('对抗：sort/tree -o 输出覆写 → false（含聚簇与 --output=）', () => {
  assert.equal(classifyBashReadonly('sort -o /tmp/pwn.txt f'), 'false');
  assert.equal(classifyBashReadonly('sort --output=/tmp/pwn.txt f'), 'false');
  assert.equal(classifyBashReadonly('sort -ro /tmp/pwn.txt f'), 'false');
  assert.equal(classifyBashReadonly('tree -o /tmp/pwn.txt .'), 'false');
  assert.equal(classifyBashReadonly('sort -u f'), 'true');
  assert.equal(classifyBashReadonly('sort -k2,2 -n f'), 'true');
});

check('对抗：sed -f 外部脚本 / 胶着 w / 任意位置 -i（含聚簇）→ false', () => {
  assert.equal(classifyBashReadonly('sed -f /tmp/evil.sed f'), 'false');
  assert.equal(classifyBashReadonly("sed 's/a/a/wpwn.txt' f"), 'false');
  assert.equal(classifyBashReadonly("sed -ni 's/a/b/' f"), 'false');
  assert.equal(classifyBashReadonly("sed -in 's/a/b/' f"), 'false');
  assert.equal(classifyBashReadonly("sed 's/a/b/' f -i"), 'false');
  assert.equal(classifyBashReadonly('sed --expression=\'s/a/b/w out.txt\' f'), 'false');
});

check('sed 误杀修复：常用只读形态 → true', () => {
  assert.equal(classifyBashReadonly("sed -e 's/a/b/' f"), 'true');
  assert.equal(classifyBashReadonly("sed 's/w/x/' f"), 'true');
  assert.equal(classifyBashReadonly("sed -E 's/a/b/' f"), 'true');
  assert.equal(classifyBashReadonly("sed --regexp-extended 's/a/b/' f"), 'true');
  assert.equal(classifyBashReadonly("sed -e's/a/b/' f"), 'true');
  assert.equal(classifyBashReadonly('sed -e "error.log" f'), 'true');
});

check('对抗：rg --pre 预处理器 → false', () => {
  assert.equal(classifyBashReadonly('rg --pre=/bin/sh pattern .'), 'false');
  assert.equal(classifyBashReadonly('rg --pre sh pattern .'), 'false');
  assert.equal(classifyBashReadonly('rg foo .'), 'true');
});

check('对抗：git remote/reflog/branch 变更型子命令 → false', () => {
  assert.equal(classifyBashReadonly('git remote set-url origin http://evil/'), 'false');
  assert.equal(classifyBashReadonly('git remote add evil http://evil/'), 'false');
  assert.equal(classifyBashReadonly('git remote remove origin'), 'false');
  assert.equal(classifyBashReadonly('git remote prune origin'), 'false');
  assert.equal(classifyBashReadonly('git reflog expire --expire=now --all'), 'false');
  assert.equal(classifyBashReadonly('git reflog delete HEAD@{1}'), 'false');
  assert.equal(classifyBashReadonly('git branch -u origin/main'), 'false');
  assert.equal(classifyBashReadonly('git branch --set-upstream-to=origin/main'), 'false');
  assert.equal(classifyBashReadonly('git branch -f main abc123'), 'false');
  assert.equal(classifyBashReadonly('git remote'), 'true');
  assert.equal(classifyBashReadonly('git remote show origin'), 'true');
  assert.equal(classifyBashReadonly('git reflog'), 'true');
  assert.equal(classifyBashReadonly('git reflog show HEAD'), 'true');
});

check('对抗：date -s / hostname 改名 / printf 十六进制 → false', () => {
  assert.equal(classifyBashReadonly('date -s "2026-01-01 00:00:00"'), 'false');
  assert.equal(classifyBashReadonly('date --set "2026-01-01"'), 'false');
  assert.equal(classifyBashReadonly('hostname newname'), 'false');
  assert.equal(classifyBashReadonly('printf "\\x41"'), 'false');
  assert.equal(classifyBashReadonly('date +%s'), 'true');
  assert.equal(classifyBashReadonly('hostname'), 'true');
});

check('审批门接线：只读模式仍拒绝绕过样本', () => {
  const hostClassOf = () => 'status';
  const decide = (cmd) =>
    decideToolPermission({
      mode: 'ask',
      planExecuting: false,
      permissionClass: 'shell',
      shellCommand: cmd,
      pathInsideRoot: null,
      mcpReadOnly: false
    });
  void hostClassOf;
  assert.equal(decide(`awk 'BEGIN{system("x")}'`), 'deny');
  assert.equal(decide('sort -o /tmp/pwn.txt f'), 'deny');
  assert.equal(decide('git remote set-url origin http://evil/'), 'deny');
  assert.equal(decide("sed -ni 's/a/b/' f"), 'deny');
});

// ── 对抗性回归（2026-09-27 复审二轮：wrapper 前缀与引号包裹不得遮蔽 flag） ──

check('对抗二轮：wrapper（env/xargs/nice/time/nohup/stdbuf）不豁免专项检查 → false', () => {
  assert.equal(classifyBashReadonly('env sed -i s/a/b/ f'), 'false');
  assert.equal(classifyBashReadonly('echo x | env FOO=1 sed -i s/a/b/ f'), 'false');
  assert.equal(classifyBashReadonly('find . -type f | xargs sed -i s/a/b/'), 'false');
  assert.equal(classifyBashReadonly('nice sort -o /tmp/pwn f'), 'false');
  assert.equal(classifyBashReadonly('time sort -o /tmp/pwn f'), 'false');
  assert.equal(classifyBashReadonly('nohup sort --output=/tmp/pwn f'), 'false');
  assert.equal(classifyBashReadonly('stdbuf -o0 sort -o /tmp/x f'), 'false');
  assert.equal(classifyBashReadonly(`echo f | xargs awk '{system("id")}'`), 'false');
  assert.equal(classifyBashReadonly('env rg --pre sh pat .'), 'false');
  assert.equal(classifyBashReadonly('env date -s 2020-01-01'), 'false');
  assert.equal(classifyBashReadonly('env find . -delete'), 'false');
  assert.equal(classifyBashReadonly('nice tree -o /tmp/pwn .'), 'false');
  assert.equal(classifyBashReadonly('echo f | xargs rm'), 'false');
  // wrapper 目标只读 → true
  assert.equal(classifyBashReadonly('env cat file'), 'true');
  assert.equal(classifyBashReadonly('nice ls -la'), 'true');
});

check('对抗二轮：引号包裹的 flag 与裸 flag 等价 → false', () => {
  assert.equal(classifyBashReadonly('sed "-i" s/a/b/ f'), 'false');
  assert.equal(classifyBashReadonly("sed '-i' 's/a/b/' f"), 'false');
  assert.equal(classifyBashReadonly('sed "s/a/b/" f "-i"'), 'false');
  assert.equal(classifyBashReadonly('sort "-o" /tmp/pwn f'), 'false');
  assert.equal(classifyBashReadonly('rg "--pre" sh pat .'), 'false');
  assert.equal(classifyBashReadonly('date "-s" 2020-01-01'), 'false');
  assert.equal(classifyBashReadonly('find . "-exec" rm {} +'), 'false');
  assert.equal(classifyBashReadonly("git branch '-D' main"), 'false');
  assert.equal(classifyBashReadonly('git reflog "expire" --expire=now --all'), 'false');
  assert.equal(classifyBashReadonly('git "--git-dir=/tmp/evil" status'), 'false');
  assert.equal(classifyBashReadonly('hostname "evil"'), 'false');
  assert.equal(classifyBashReadonly('echo f | xargs "rm"'), 'false');
});

check('对抗二轮：awk -f 外部脚本 / git branch 聚簇 / GNU 长选项前缀 / printf \\u → false', () => {
  assert.equal(classifyBashReadonly('awk -f /tmp/evil.awk f'), 'false');
  assert.equal(classifyBashReadonly('awk --file=/tmp/evil.awk f'), 'false');
  assert.equal(classifyBashReadonly('git branch -Df main'), 'false');
  assert.equal(classifyBashReadonly('git branch -df main'), 'false');
  assert.equal(classifyBashReadonly('git branch -fu origin/main main'), 'false');
  assert.equal(classifyBashReadonly('sort --out=/tmp/pwn f'), 'false');
  assert.equal(classifyBashReadonly('sort --o=/tmp/pwn f'), 'false');
  assert.equal(classifyBashReadonly('date --se=2020-01-01'), 'false');
  assert.equal(classifyBashReadonly("printf '\\u0041'"), 'false');
  // 良性对照
  assert.equal(classifyBashReadonly('git branch -av'), 'true', '-av（全列出）不被聚簇误伤');
  assert.equal(classifyBashReadonly('sed --expression=\'s/a/b/\' f'), 'true', '--expression 首参位置的良性形态');
});

check('对抗二轮：ask/plan 只读门同源消费（引号/wrapper 不得穿透 deny→auto）', () => {
  assert.equal(isReadOnlyShellCommand('sed -n "-i" s/a/b/ f'), false);
  assert.equal(isReadOnlyShellCommand("sed -n '-i' 's/a/b/' f"), false);
  assert.equal(isReadOnlyShellCommand("git branch '-D' main"), false);
  assert.equal(isReadOnlyShellCommand('awk -f /tmp/evil.awk f'), false);
  assert.equal(isReadOnlyShellCommand('env sed -i s/a/b/ f'), false);
  assert.equal(isReadOnlyShellCommand('git branch -f main abc'), false, '两门判定一致（-f 聚簇）');
  // 良性对照：只读白名单面不收缩
  assert.equal(isReadOnlyShellCommand('sed -n "p" file'), true);
  assert.equal(isReadOnlyShellCommand('grep pattern file'), true);
  assert.equal(isReadOnlyShellCommand('git status'), true);
});

// ── 对抗性回归（2026-09-27 三轮核验：转义/ANSI-C 引号/嵌套 wrapper） ──

check('对抗三轮：反斜杠转义 flag（sed \\-i 与 sed -i 同 argv）→ false', () => {
  assert.equal(classifyBashReadonly('sed \\-i s/a/b/ f'), 'false');
  assert.equal(classifyBashReadonly('find . \\-delete'), 'false');
  assert.equal(classifyBashReadonly('git branch \\-D main'), 'false');
  assert.equal(classifyBashReadonly('awk \\-f /tmp/evil.awk f'), 'false');
  assert.equal(classifyBashReadonly('rg \\--pre sh pat .'), 'false');
  assert.equal(classifyBashReadonly('sort \\-o /tmp/pwn f'), 'false');
  assert.equal(classifyBashReadonly('date \\-s 2020-01-01'), 'false');
  // 只读门同防
  assert.equal(isReadOnlyShellCommand('find . \\-delete'), false);
  assert.equal(isReadOnlyShellCommand('rg \\--pre sh pat .'), false);
});

check('对抗三轮：ANSI-C 引号 $\'…\'（与裸 flag 同 argv）→ false', () => {
  assert.equal(classifyBashReadonly("sed $'-i' s/a/b/ f"), 'false');
  assert.equal(classifyBashReadonly("find . $'-delete'"), 'false');
  assert.equal(classifyBashReadonly("git branch $'-D' main"), 'false');
  assert.equal(classifyBashReadonly("awk $'-f' /tmp/evil.awk f"), 'false');
  assert.equal(classifyBashReadonly("rg $'--pre' sh pat ."), 'false');
  // 只读门同防
  assert.equal(isReadOnlyShellCommand("find . $'-delete'"), false);
  assert.equal(isReadOnlyShellCommand("git branch $'-D' main"), false);
});

check('对抗三轮：嵌套 wrapper（env env sed / xargs env sort）逐层剥 → false', () => {
  assert.equal(classifyBashReadonly('env env sed -i s/a/b/ f'), 'false');
  assert.equal(classifyBashReadonly('xargs env sed -i s/a/b/'), 'false');
  assert.equal(classifyBashReadonly('nice env sort -o /tmp/pwn f'), 'false');
  assert.equal(classifyBashReadonly('nohup env date -s 2020-01-01'), 'false');
  assert.equal(classifyBashReadonly('time env sort -o /tmp/pwn f'), 'false');
  assert.equal(classifyBashReadonly('timeout 5 env find . -delete'), 'false');
  // 嵌套 wrapper 的良性目标 → true
  assert.equal(classifyBashReadonly('env env cat file'), 'true');
  assert.equal(classifyBashReadonly('nice env ls -la'), 'true');
  // 深层嵌套良性超界 → unknown（fail-closed）
  assert.equal(classifyBashReadonly('env env env env env env env env env cat f'), 'unknown');
});

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll bash-readonly tests passed');
