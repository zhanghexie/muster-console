import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareExtensionReviewCatalog, reviewExtensionSubmission } from '../scripts/review-extension-submission.mjs';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-submission-review-'));
const repository = 'https://github.com/author/my-extension';
const version = '1.0.0';
const commit = 'a'.repeat(40);
const command = 'throw new Error("The checker and installer must never run candidate code");\n';

try {
  const source = path.join(temp, 'review-fixture');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'extension.json'), JSON.stringify({
    id: 'review-fixture', name: 'Review fixture', version, scope: 'global', permissions: ['hostTools'],
    surface: { kind: 'toolbar', command: 'hello' }, commandEntry: 'command.mjs',
    commands: [{ id: 'hello', title: 'Hello', handler: 'hello' }],
  }));
  const pack = async (file, code) => {
    await fs.writeFile(path.join(source, 'command.mjs'), code);
    const target = path.join(temp, file);
    execFileSync(process.execPath, ['scripts/pack-extension-release.mjs', source, target]);
    return fs.readFile(target);
  };
  const bytes = await pack('packed.json', command);
  const output = path.join(temp, 'review');
  const options = { repository, version, commit, output, readTags: async url => {
    assert.equal(url, `${repository}.git`);
    return `${commit}\trefs/tags/v${version}`;
  }, fetchImpl: async (url, init) => {
    assert.equal(url.href, `https://api.github.com/repos/author/my-extension/contents/releases/${version}.json?ref=${commit}`);
    assert.equal(init.headers.Authorization, undefined);
    return new Response(bytes);
  } };
  const report = await reviewExtensionSubmission(options);
  assert.equal(report.sourceCommit, commit);
  assert.equal(report.commandEntry, 'command.mjs');
  assert.deepEqual(report.permissions, ['hostTools']);
  assert.equal(report.syntaxChecked, 1);
  assert.deepEqual(await fs.readFile(path.join(output, 'candidate.json')), bytes);

  const wrongCommit = 'b'.repeat(40);
  const noOutput = path.join(temp, 'bad');
  await assert.rejects(reviewExtensionSubmission({ ...options, output: noOutput, commit: wrongCommit }), /tag does not point/);
  const changed = JSON.parse(bytes.toString('utf8'));
  changed.files.find(file => file.path === 'command.mjs').bytesBase64 = Buffer.from('changed').toString('base64');
  await assert.rejects(reviewExtensionSubmission({ ...options, output: noOutput,
    fetchImpl: async () => new Response(JSON.stringify(changed)) }), /snapshot was modified/);
  const invalidCode = await pack('bad-syntax.json', 'export const =;');
  await assert.rejects(reviewExtensionSubmission({ ...options, output: noOutput,
    fetchImpl: async () => new Response(invalidCode) }), /Could not parse "command.mjs" at line 1/);
  await assert.rejects(fs.stat(noOutput), { code: 'ENOENT' });

  const moved = path.join(temp, 'downloaded review');
  await fs.rename(output, moved);
  const catalogUrl = await prepareExtensionReviewCatalog(moved);
  assert.equal(await prepareExtensionReviewCatalog(moved), catalogUrl);
  const compile = createSharedCompiler(path.resolve(import.meta.dirname, '..'), path.join(temp, 'compiled'));
  const { ExtensionCenterService } = await import(pathToFileURL(compile('main/extensions/extensionCenter.ts')));
  const { ExtensionPackageCatalog } = await import(pathToFileURL(compile('main/extensions/extensionPackageCatalog.ts')));
  const { ExtensionSourceLayout } = await import(pathToFileURL(compile('main/extensions/extensionSourceLayout.ts')));
  const userData = path.join(temp, 'review-profile');
  const layout = new ExtensionSourceLayout({ userData });
  const center = new ExtensionCenterService(userData, layout.globalRoot, new ExtensionPackageCatalog({ layout }), { catalogUrl });
  assert.deepEqual((await center.list()).map(release => release.packageKey), [report.release.packageKey]);
  await center.install(report.release.packageKey);
  const installed = await layout.discover({ scope: 'global', extensionId: report.release.extensionId });
  assert.equal(installed.fingerprint, report.release.fingerprint);

  await fs.writeFile(path.join(moved, 'candidate.json'), 'changed');
  await assert.rejects(prepareExtensionReviewCatalog(moved), /does not match the reviewed package digest/);
  console.log('Pinned extension review, source syntax, checksum and preview installation passed.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
