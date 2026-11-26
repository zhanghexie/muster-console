/**
 * 宿主能力域技能正文安装/升级链（P1，2026-10-23）：包内真源 resources/skills →
 * ~/.muster/skills 的三态矩阵（缺→写 / 包新→覆盖 / 磁盘≥包→不动）+
 * dev/打包两态的包内根解析 + 仓内真源完整性（宿主域齐、x-muster-version 可解析）。
 * 离线真实文件系统；fixture 根注入，不碰真实 ~/.muster。
 * 运行: node test/host-skill-provision.mjs
 */
import assert from 'node:assert/strict';
import {parse as parseYaml} from 'yaml';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-skill-provision-'));
const compile = createSharedCompiler(root, tmp);
// 树式转译：hostSkillProvision 及其依赖（hostDomainSkills → runFactory/runTools、i18n shim）自动带上
const {
  provisionHostDomainSkills,
  resolveBundledSkillsDir,
  readSkillVersion,
  compareVersions,
  SKILL_VERSION_FIELD
} = await import(pathToFileURL(compile('main/metaAgent/hostSkillProvision.ts')));
const { hostSkillDomainDirs } = await import(
  pathToFileURL(compile('main/metaAgent/hostDomainSkills.ts'))
);

const domains = [...hostSkillDomainDirs()];
assert.equal(domains.length, 19, '宿主声明域技能数量');
assert.ok(domains.includes('core-context'));
assert.ok(domains.includes('muster-extensions'));
assert.ok(domains.includes('ui-widget-design'));

const mkSkill = (name, version, body = `BODY ${name}`) =>
  `---\nname: ${name}\nx-muster-version: ${version}\ndescription: fixture ${name}\n---\n\n${body}\n`;

try {
  // ---- 0) 纯函数：版本读取与比较 ----
  {
    assert.equal(readSkillVersion(mkSkill('x', '0.1.31')), '0.1.31');
    assert.equal(readSkillVersion('---\nname: x\n---\n\nx-muster-version: 9.9.9\n'), null, '正文里的字段不算');
    assert.equal(readSkillVersion('no frontmatter\nx-muster-version: 1\n'), null, '无 frontmatter → null');
    assert.equal(readSkillVersion('---\nname: x\n'), null, 'frontmatter 未闭合 → null');
    assert.equal(compareVersions('0.1.31', '0.1.9'), 1);
    assert.equal(compareVersions('0.1.9', '0.1.31'), -1);
    assert.equal(compareVersions('1.0', '1.0.0'), 0, '缺失段按 0');
    assert.equal(compareVersions('0.2', '0.10'), -1, '数字比较不是字符串比较');
    assert.equal(SKILL_VERSION_FIELD, 'x-muster-version');
  }

  // ---- 1) 包内根解析：dev（out/main 上溯到仓库 resources/skills）与打包（resourcesPath/skills） ----
  {
    const dev = resolveBundledSkillsDir({
      isPackaged: false,
      resourcesPath: '/ignored/install/resources',
      moduleDir: path.join(root, 'out', 'main')
    });
    assert.equal(dev, path.join(root, 'resources', 'skills'), 'dev 态 = 仓库 resources/skills 原地');
    const pkg = resolveBundledSkillsDir({
      isPackaged: true,
      resourcesPath: path.join(path.sep, 'install', 'resources'),
      moduleDir: '/wherever/out/main'
    });
    assert.equal(pkg, path.join(path.sep, 'install', 'resources', 'skills'), '打包态 = extraResources 落点');
  }

  // ---- 2) 仓内真源完整性：每个宿主域各一份 SKILL.md，版本字段为点分数字且非零 ----
  {
    for (const dir of domains) {
      const p = path.join(root, 'resources', 'skills', dir, 'SKILL.md');
      const text = fs.readFileSync(p, 'utf8');
      assert.ok(text.length > 100, `${dir} 真源非空`);
      if(dir==='memory'){
        const front=parseYaml(text.split('---')[1]);
        assert.equal(front.name,'memory');
        assert.equal(typeof front.description,'string','memory description is valid YAML even with a colon');
      }
      const v = readSkillVersion(text);
      assert.match(v ?? '', /^\d+(\.\d+)+$/, `${dir} x-muster-version 须为点分数字（当前升级判定字段）`);
      assert.ok(compareVersions(v, '0.0.1') > 0, `${dir} 版本应大于 0.0.1`);
      if (dir === 'muster-extensions') assert.match(text, /name: muster-extensions/);
      if (dir === 'ui-widget-design') {
        assert.match(text, /x-muster-skill: ui-widget-design/);
        for (const example of ['three-demo.fragment.html', 'convenience-demo.fragment.html', 'expanded-demo.fragment.html']) {
          assert.ok(fs.existsSync(path.join(root, 'resources', 'skills', dir, 'examples', example)), `${dir} companion resource ${example}`);
        }
      }
    }
    // 与磁盘宿主域清单对账：resources/skills 不多不少
    const onDisk = fs
      .readdirSync(path.join(root, 'resources', 'skills'), { withFileTypes: true })
      .filter((it) => it.isDirectory())
      .map((it) => it.name)
      .sort();
    assert.deepEqual(onDisk, [...domains].sort(), 'resources/skills 域目录与九域清单一致');
  }

  // fixture：受控包内根（宿主域 v1.0.0）与落盘根
  const bundledRoot = path.join(tmp, 'bundled');
  const skillRoot = path.join(tmp, 'target');
  for (const dir of domains) {
    fs.mkdirSync(path.join(bundledRoot, dir), { recursive: true });
    fs.writeFileSync(path.join(bundledRoot, dir, 'SKILL.md'), mkSkill(dir, '1.0.0'), 'utf8');
  }

  // ---- 3) 安装态：落盘根缺域 → 补齐所有宿主域，字节等同真源 ----
  {
    const res = provisionHostDomainSkills({ bundledRootDir: bundledRoot, skillRootDir: skillRoot });
    assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
    assert.deepEqual([...res.installed].sort(), [...domains].sort());
    assert.equal(res.updated.length, 0);
    assert.equal(res.kept.length, 0);
    assert.equal(res.invalidBundled.length, 0);
    for (const dir of domains) {
      assert.equal(
        fs.readFileSync(path.join(skillRoot, dir, 'SKILL.md'), 'utf8'),
        fs.readFileSync(path.join(bundledRoot, dir, 'SKILL.md'), 'utf8'),
        `${dir} 落盘字节等同真源`
      );
    }
  }

  // ---- 4) 同版态：磁盘同版 → 不动（零写入，mtime 稳定） ----
  {
    const stamps = Object.fromEntries(
      domains.map((dir) => [dir, fs.statSync(path.join(skillRoot, dir, 'SKILL.md')).mtimeMs])
    );
    const res = provisionHostDomainSkills({ bundledRootDir: bundledRoot, skillRootDir: skillRoot });
    assert.equal(res.errors.length, 0);
    assert.equal(res.installed.length, 0);
    assert.equal(res.updated.length, 0);
    assert.deepEqual([...res.kept].sort(), [...domains].sort());
    for (const dir of domains) {
      assert.equal(
        fs.statSync(path.join(skillRoot, dir, 'SKILL.md')).mtimeMs,
        stamps[dir],
        `${dir} 同版零写入`
      );
    }
  }

  // ---- 5) 升级态：包新 → 覆盖（含磁盘被用户改过但版本旧 → 仍覆盖，宿主自有文档取舍）；
  //          磁盘版本更新（应用降级场景） → 不动 ----
  {
    // browser 真源升 2.0.0 → 覆盖；llm 真源升 2.0.0 且磁盘被用户改过（版本仍 1.0.0）→ 仍覆盖；
    // themes 磁盘手写 9.9.9（≥ 包 1.0.0）→ 不动
    fs.writeFileSync(path.join(bundledRoot, 'browser', 'SKILL.md'), mkSkill('browser', '2.0.0', 'BROWSER V2'), 'utf8');
    fs.writeFileSync(path.join(bundledRoot, 'llm', 'SKILL.md'), mkSkill('llm', '2.0.0', 'LLM V2'), 'utf8');
    fs.appendFileSync(path.join(skillRoot, 'llm', 'SKILL.md'), '\nUSER LOCAL EDIT\n', 'utf8');
    fs.writeFileSync(path.join(skillRoot, 'themes', 'SKILL.md'), mkSkill('themes', '9.9.9', 'NEWER DISK'), 'utf8');
    const res = provisionHostDomainSkills({ bundledRootDir: bundledRoot, skillRootDir: skillRoot });
    assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
    assert.deepEqual([...res.updated].sort(), ['browser', 'llm'], '仅包新的两域覆盖');
    assert.equal(res.installed.length, 0);
    assert.ok(res.kept.includes('themes'), '磁盘版本更高的域不动');
    assert.ok(res.kept.includes('workflow'), '同版域不动');
    assert.ok(
      fs.readFileSync(path.join(skillRoot, 'browser', 'SKILL.md'), 'utf8').includes('BROWSER V2'),
      'browser 已覆盖为新版'
    );
    assert.ok(
      fs.readFileSync(path.join(skillRoot, 'llm', 'SKILL.md'), 'utf8').includes('LLM V2') &&
        !fs.readFileSync(path.join(skillRoot, 'llm', 'SKILL.md'), 'utf8').includes('USER LOCAL EDIT'),
      'llm 磁盘被用户改过但版本旧 → 仍被包新版覆盖（宿主自有文档取舍）'
    );
    assert.ok(
      fs.readFileSync(path.join(skillRoot, 'themes', 'SKILL.md'), 'utf8').includes('NEWER DISK'),
      '磁盘版本更高不动（应用降级场景）'
    );
  }

  // ---- 6) 无版本字段的旧磁盘文件（R3a 手工部署形态）→ 视为旧，包内容覆盖 ----
  {
    fs.writeFileSync(
      path.join(skillRoot, 'panel', 'SKILL.md'),
      `---\nname: panel\ndescription: legacy hand-installed\n---\n\nOLD HAND CONTENT\n`,
      'utf8'
    );
    const res = provisionHostDomainSkills({ bundledRootDir: bundledRoot, skillRootDir: skillRoot });
    assert.equal(res.errors.length, 0);
    assert.deepEqual(res.installed, ['panel'], '无版本字段的旧文件按缺域补齐（覆盖）');
    assert.ok(
      fs.readFileSync(path.join(skillRoot, 'panel', 'SKILL.md'), 'utf8').includes('BODY panel'),
      '旧手工内容被真源替换'
    );
  }

  // ---- 7) 包内异常：某域缺失 / 某域版本字段坏 → 跳过 + 不写盘，其余照常 ----
  {
    const warnTexts = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnTexts.push(args.join(' '));
    try {
      fs.rmSync(path.join(bundledRoot, 'runtimes', 'SKILL.md'), { force: true });
      fs.writeFileSync(
        path.join(bundledRoot, 'extensions', 'SKILL.md'),
        `---\nname: extensions\ndescription: no version field\n---\n\nNO VERSION\n`,
        'utf8'
      );
      const res = provisionHostDomainSkills({ bundledRootDir: bundledRoot, skillRootDir: skillRoot });
      assert.equal(res.errors.length, 0);
      assert.deepEqual([...res.invalidBundled].sort(), ['extensions', 'runtimes']);
      assert.equal(res.kept.length + res.updated.length + res.installed.length, domains.length - 2, '其余七域照常处理');
      assert.ok(warnTexts.some((line) => line.includes('runtimes')), '缺失域有告警');
      assert.ok(warnTexts.some((line) => line.includes('extensions')), '坏版本域有告警');
      assert.equal(fs.existsSync(path.join(skillRoot, 'runtimes', 'SKILL.md')), true, '已有磁盘文件不被误删');
    } finally {
      console.warn = origWarn;
    }
  }

  // ---- 8) 真源实跑：用仓内 resources/skills 向受控根安装 → 所有宿主域齐、版本字段在位 ----
  {
    const target = path.join(tmp, 'from-repo');
    const res = provisionHostDomainSkills({
      bundledRootDir: path.join(root, 'resources', 'skills'),
      skillRootDir: target
    });
    assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
    assert.equal(res.invalidBundled.length, 0);
    assert.equal(res.installed.length, domains.length);
    for (const skill of ['extensions', 'muster-extensions']) {
      const guide = fs.readFileSync(path.join(target, skill, 'SKILL.md'), 'utf8');
      assert.doesNotMatch(guide, /^\| `(?:run|tools|invokeTool)` \|/m);
      assert.match(guide, /expectedFingerprint/);
      assert.match(guide, /retryReview.*scope/);
      assert.match(guide, /ma\.tool/);
    }
    for (const dir of domains) {
      assert.equal(
        fs.readFileSync(path.join(target, dir, 'SKILL.md'), 'utf8'),
        fs.readFileSync(path.join(root, 'resources', 'skills', dir, 'SKILL.md'), 'utf8'),
        `${dir} 与仓内真源字节一致`
      );
    }
    for (const example of ['three-demo.fragment.html', 'convenience-demo.fragment.html', 'expanded-demo.fragment.html']) {
      assert.equal(
        fs.readFileSync(path.join(target, 'ui-widget-design', 'examples', example), 'utf8'),
        fs.readFileSync(path.join(root, 'resources', 'skills', 'ui-widget-design', 'examples', example), 'utf8'),
        `ui-widget-design companion resource ${example} 与仓内真源字节一致`
      );
    }
  }
  {
    const target=path.join(tmp,'user-memory-conflict');fs.mkdirSync(path.join(target,'memory'),{recursive:true});
    fs.writeFileSync(path.join(target,'memory','SKILL.md'),'user-owned memory skill');
    const result=provisionHostDomainSkills({bundledRootDir:path.join(root,'resources','skills'),skillRootDir:target,domains:['memory']});
    assert.equal(result.errors.length,1);assert.equal(fs.readFileSync(path.join(target,'memory','SKILL.md'),'utf8'),'user-owned memory skill');
  }
  {
    const target=path.join(tmp,'user-feedback-conflict');fs.mkdirSync(path.join(target,'feedback'),{recursive:true});
    fs.writeFileSync(path.join(target,'feedback','SKILL.md'),'user-owned feedback skill');
    const result=provisionHostDomainSkills({bundledRootDir:path.join(root,'resources','skills'),skillRootDir:target,domains:['feedback']});
    assert.equal(result.errors.length,1);assert.equal(fs.readFileSync(path.join(target,'feedback','SKILL.md'),'utf8'),'user-owned feedback skill');
  }
  {
    const target = path.join(tmp, 'interrupted-muster-rename');
    const bundled = fs.readFileSync(path.join(root, 'resources/skills/feedback/SKILL.md'), 'utf8');
    const oldMarker = bundled.replace('x-muster-version:', 'x-metaagent-version:');
    assert.equal(readSkillVersion(oldMarker), null, 'the runtime parser accepts only the new marker');
    const file = path.join(target, 'feedback/SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, oldMarker);
    const result = provisionHostDomainSkills({ bundledRootDir: path.join(root, 'resources/skills'), skillRootDir: target, domains: ['feedback'] });
    assert.deepEqual(result.errors, []);
    assert.equal(fs.readFileSync(file, 'utf8'), bundled, 'exact shipped copy in the new root is repaired');
    fs.writeFileSync(file, oldMarker + '\nuser customization');
    const conflict = provisionHostDomainSkills({ bundledRootDir: path.join(root, 'resources/skills'), skillRootDir: target, domains: ['feedback'] });
    assert.equal(conflict.errors.length, 1);
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('user customization'));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('host-skill-provision: ok');
