import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { patchLarkSdkHandshakeSource } from '../src/main/messaging/dsh-im/adapters/host/lark-sdk-handshake-patch.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeSource = path.join(root, 'src', 'main', 'messaging', 'dsh-im');
const outdir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'out', 'main', 'messaging');
const require = createRequire(import.meta.url);
const larkEntry = require.resolve('@larksuiteoapi/node-sdk');
const larkManifest = JSON.parse(await readFile(path.join(path.dirname(larkEntry), '..', 'package.json'), 'utf8'));

await mkdir(outdir, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { 'channel-runtime': path.join(runtimeSource, 'channel-runtime.mjs') },
  outdir,
  outExtension: { '.js': '.mjs' },
  chunkNames: 'channel-chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  legalComments: 'eof',
  plugins: [
    {
      name: 'bundle-reviewed-lark-sdk',
      setup(builder) {
        builder.onResolve({ filter: /^@larksuiteoapi\/node-sdk$/ }, () => ({
          path: larkEntry
        }));
        builder.onLoad({ filter: /@larksuiteoapi[\\/]node-sdk[\\/](es|lib)[\\/]index\.js$/ }, async ({ path: sourcePath }) => {
          const source = patchLarkSdkHandshakeSource(await readFile(sourcePath, 'utf8'), sourcePath);
          // The original helper uses __dirname in its SDK package; this module will live in an app chunk.
          const versionFunction = /function getSdkVersion\(\) \{[\s\S]*?\n\}/g;
          if ([...source.matchAll(versionFunction)].length !== 1 || typeof larkManifest.version !== 'string') {
            throw new Error('Could not locate the version helper in the bundled Lark SDK');
          }
          return {
            contents: source.replace(versionFunction, `function getSdkVersion() { return ${JSON.stringify(larkManifest.version)}; }`),
            loader: 'js'
          };
        });
      }
    }
  ],
  banner: { js: 'import { createRequire as createChannelRequire } from "node:module"; const require = createChannelRequire(import.meta.url);' }
});

const [license, notices] = await Promise.all(['LICENSE', 'THIRD_PARTY_NOTICES.md']
  .map(file => readFile(path.join(runtimeSource, file), 'utf8')));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const sdkPackages = [
  '@larksuiteoapi/node-sdk', '@matrix-org/olm', '@tencent-connect/qqbot-nodejs',
  '@wecom/aibot-node-sdk', '@whiskeysockets/baileys', 'dingtalk-stream', 'https-proxy-agent',
  'imapflow', 'mailparser', 'nodemailer', 'protobufjs', 'qrcode', 'sharp', 'undici'
];
const resolvedVersions = sdkPackages.map(name => `${name}@${lock.packages[`node_modules/${name}`]?.version ?? 'unresolved'}`);
const distribution = [
  'Muster message integration, adapted from dsh-im 5.10.0 (fc2ceab217309f8973afa03c58cdd8ff3e900130).',
  'Muster SDK versions from the package lock for this build:',
  ...resolvedVersions.map(version => `  ${version}`),
  '',
  'Only the reviewed Lark SDK is bundled into a platform chunk. Other SDKs remain package dependencies.',
  'The upstream notices below describe the source distribution and its package versions.',
  'The QQ QR connector and the Agent Mail CLI are separate optional components; they are not distributed here.',
  ''
].join('\n');
await writeFile(path.join(outdir, 'dsh-im-attribution.txt'), `${distribution}\n${license}\n\n${notices}`, 'utf8');
