import fs from 'node:fs/promises';
import path from 'node:path';

export const viteFixtureAssets = {
  name: 'vite-fixture-assets',
  setup(builder) {
    builder.onLoad({ filter: /extensionIcons\.tsx$/ }, async ({ path: filename }) => {
      const source = await fs.readFile(filename, 'utf8');
      const glob = /import\.meta\.glob\('\.\/assets\/extensions\/\*\.svg', \{[^}]*\}\)/;
      if (!glob.test(source)) return;
      const directory = path.dirname(filename);
      const assets = (await fs.readdir(path.join(directory, 'assets', 'extensions'))).sort();
      const entries = assets.filter(asset => asset.endsWith('.svg')).map(asset => './assets/extensions/' + asset);
      const imports = entries.map((asset, index) => `import icon${index} from ${JSON.stringify(asset)};`);
      const modules = entries.map((asset, index) => `${JSON.stringify(asset)}: icon${index}`);
      return { contents: imports.join('\n') + '\n' + source.replace(glob, `({${modules.join(',')}})`), loader: 'tsx', resolveDir: directory };
    });
    builder.onLoad({ filter: /./ }, async args => args.suffix === '?raw'
      ? { contents: await fs.readFile(args.path, 'utf8'), loader: 'text' } : undefined);
  }
};
