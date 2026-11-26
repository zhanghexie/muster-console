declare module 'unidiff' {
  export function createTwoFilesPatch(oldName: string, newName: string, oldText: string, newText: string): string;
  export function applyPatch(source: string, patch: string): string | false;
  const unidiff: { createTwoFilesPatch: typeof createTwoFilesPatch; applyPatch: typeof applyPatch };
  export default unidiff;
}
