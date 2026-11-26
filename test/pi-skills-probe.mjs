import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const wt = require('node:worker_threads');
if (typeof wt.markAsUncloneable !== 'function') wt.markAsUncloneable = () => {};

const {
  DefaultResourceLoader,
  getAgentDir
} = await import('@earendil-works/pi-coding-agent');

const cwd = 'd:\\MetaApp';
const skillPaths = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.agents', 'skills'),
  path.join(cwd, '.cursor', 'skills')
];

const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  additionalSkillPaths: skillPaths,
  appendSystemPrompt: ['MetaAgent append test']
});
await loader.reload({ resolveProjectTrust: async () => true });
const skills = loader.getSkills().skills;
const agents = loader.getAgentsFiles().agentsFiles;
console.log(
  JSON.stringify(
    {
      skills: skills.length,
      agents: agents.map((a) => a.path),
      sample: skills.slice(0, 12).map((s) => s.name)
    },
    null,
    2
  )
);
process.exit(0);
