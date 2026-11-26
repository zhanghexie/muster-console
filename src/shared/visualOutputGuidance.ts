export function buildVisualOutputGuidance(surface: 'chat' | 'terminal', interactiveTool?: string): string {
  const markdownScope = surface === 'terminal' ? ' in Markdown deliverables' : '';
  const use = surface === 'terminal' ? 'If available, use' : 'Use';
  return [
    `Use fenced \`mermaid\` blocks${markdownScope} to clarify flows, dependencies, or state changes.`,
    interactiveTool && `${use} ${interactiveTool} when filtering or testing scenarios would help.`
  ].filter(Boolean).join(' ');
}
