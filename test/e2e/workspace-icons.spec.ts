import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('工作区创建/编辑可选透明分类图标，左栏和看板同源，完整重启保持', async () => {
  const project = path.resolve(__dirname, '../..');
  const cwd = fs.mkdtempSync(path.join(project, '.tmp', 'workspace-icons-e2e-'));
  const userData = path.join(cwd, '.dev-sandbox/userData'); fs.mkdirSync(userData, { recursive: true });
  const legacy = path.join(cwd, 'legacy'), source = path.join(cwd, 'source');
  fs.mkdirSync(legacy); fs.mkdirSync(source);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale:'zh-CN',themeId:'dark',workspace:legacy,
    activeWorkspaceId:'legacy',workspaces:[{id:'legacy',name:'Legacy emoji',path:legacy,avatar:'😺'}],
    mcp:{enabled:false,servers:[]} }));
  const env: Record<string,string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string] => typeof e[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','MUSTER_NO_SANDBOX','MUSTER_DEVTOOLS_PORT','MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX='1'; env.MUSTER_INSTANCE_ID=path.basename(cwd);
  const launch = () => _electron.launch({executablePath:require('electron'),args:[project,'--disable-gpu'],cwd,env});
  let app = await launch();
  try {
    let win = await app.firstWindow(); await win.locator('.app-shell').waitFor({timeout:60_000});
    await app.evaluate(({dialog},source) => { dialog.showOpenDialog = async () => ({canceled:false,filePaths:[source]}); }, source);
    // Native hover can be lost when another Windows app takes focus. Activate the
    // existing entry only; all icon, save, edit and restart actions below use real UI/IPC.
    // This test does not claim to verify the workspace header hover affordance.
    await win.getByTitle('新建工作区',{exact:true}).evaluate((button:HTMLButtonElement)=>button.click());
    const create = win.getByRole('dialog',{name:'新建工作区'});
    await create.getByRole('button',{name:'添加文件夹',exact:true}).click();
    await create.getByRole('textbox',{name:'工作区名称',exact:true}).fill('Workspace icon test');
    await expect(create.getByRole('button',{name:'更换头像'}).locator('img')).toHaveAttribute('src',/development-[\w-]+\.webp$/);
    await create.getByRole('button',{name:'更换头像'}).click();
    await expect(create.getByRole('option')).toHaveCount(36);
    await expect(create.getByPlaceholder('自定义 emoji')).toHaveCount(0);
    await expect(create.getByRole('button',{name:'用 emoji'})).toHaveCount(0);
    await create.getByRole('option',{name:'通用游戏',exact:true}).click();
    await expect(create.getByRole('option',{name:'通用游戏',exact:true})).toHaveAttribute('aria-selected','true');
    await expect.poll(() => create.locator('[role=option] img').evaluateAll(imgs => imgs.every(img => (img as HTMLImageElement).naturalWidth === 256))).toBe(true);
    await create.screenshot({path:path.join(cwd,'create-gamepad.png')});
    await create.getByRole('button',{name:'创建',exact:true}).click(); await expect(create).toBeHidden();
    const current = () => win.evaluate(async () => { const cfg=await window.api.config.get(); return cfg.workspaces.find(w=>w.id===cfg.activeWorkspaceId)!; });
    expect((await current()).avatar).toBe('builtin-workspace:gamepad');
    expect((await current()).avatarAccent).toMatch(/^#[0-9a-f]{6}$/i);
    const activeFace = () => win.locator('.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-ws-stack-item.is-active .agent-float-avatar');
    await expect(activeFace().locator('img')).toHaveAttribute('src',/gamepad-[\w-]+\.webp$/);
    await activeFace().click({button:'right'});
    await win.locator('#ctx-item-workspace-edit').click();
    const edit = win.getByRole('dialog',{name:'编辑工作区'});
    await edit.getByRole('button',{name:'更换头像'}).click();
    await expect(edit.getByRole('option',{name:'通用游戏',exact:true})).toHaveAttribute('aria-selected','true');
    await edit.getByRole('option',{name:'新闻',exact:true}).click();
    await edit.getByRole('button',{name:'保存',exact:true}).click(); await expect(edit).toBeHidden();
    expect((await current()).avatar).toBe('builtin-workspace:news');
    await expect(activeFace().locator('img')).toHaveAttribute('src',/news-[\w-]+\.webp$/);
    await win.evaluate(() => { void window.api.app.quit(); }).catch(()=>{}); await app.close();
    app = await launch(); win=await app.firstWindow(); await win.locator('.app-shell').waitFor({timeout:60_000});
    await expect(activeFace().locator('img')).toHaveAttribute('src',/news-[\w-]+\.webp$/);
    await activeFace().click({button:'right'});
    await win.locator('#ctx-item-workspace-edit').click();
    const restored = win.getByRole('dialog',{name:'编辑工作区'});
    await restored.getByRole('button',{name:'更换头像'}).click();
    await expect(restored.getByRole('option',{name:'新闻',exact:true})).toHaveAttribute('aria-selected','true');
    await restored.screenshot({path:path.join(cwd,'restarted-edit-news.png')});
    await restored.getByRole('button',{name:'关闭',exact:true}).click();
    await win.getByRole('button',{name:'全局看板',exact:true}).click();
    await expect(win.locator('.board-sched-card')).toHaveCount(0);
    const cfg=await win.evaluate(()=>window.api.config.get());
    expect(cfg.workspaces.find(w=>w.id==='legacy')?.avatar).toBe('😺');
    const disk=JSON.parse(fs.readFileSync(path.join(userData,'config.json'),'utf8'));
    expect(disk.workspaces.find((w:{name:string})=>w.name==='Workspace icon test').avatar).toBe('builtin-workspace:news');
  } finally { await app.close().catch(()=>{}); }
});
