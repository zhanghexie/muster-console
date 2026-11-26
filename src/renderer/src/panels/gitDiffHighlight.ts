import refractor from 'refractor/core';
import bash from 'refractor/lang/bash';
import c from 'refractor/lang/c';
import cpp from 'refractor/lang/cpp';
import csharp from 'refractor/lang/csharp';
import css from 'refractor/lang/css';
import go from 'refractor/lang/go';
import java from 'refractor/lang/java';
import javascript from 'refractor/lang/javascript';
import json from 'refractor/lang/json';
import jsx from 'refractor/lang/jsx';
import markdown from 'refractor/lang/markdown';
import markup from 'refractor/lang/markup';
import python from 'refractor/lang/python';
import rust from 'refractor/lang/rust';
import sql from 'refractor/lang/sql';
import toml from 'refractor/lang/toml';
import tsx from 'refractor/lang/tsx';
import typescript from 'refractor/lang/typescript';
import yaml from 'refractor/lang/yaml';

const langs = [
  bash,
  c,
  cpp,
  csharp,
  css,
  go,
  java,
  javascript,
  json,
  jsx,
  markdown,
  markup,
  python,
  rust,
  sql,
  toml,
  tsx,
  typescript,
  yaml
];

for (const lang of langs) {
  try {
    refractor.register(lang);
  } catch {
    /* already registered */
  }
}

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  vue: 'jsx',
  svelte: 'jsx'
};

export function languageFromPath(filePath: string | undefined | null): string | null {
  if (!filePath) return null;
  const base = filePath.split(/[/\\]/).pop() ?? filePath;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  const lang = EXT_LANG[ext];
  if (!lang) return null;
  if (!refractor.registered(lang)) return null;
  return lang;
}

export { refractor };
