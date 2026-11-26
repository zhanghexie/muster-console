import { createContext, useRef } from 'react';
/** Tool output owns the artifact's placement; assistant Markdown references are suppressed. */
export const EMPTY_UI_ARTIFACT_PATHS: readonly string[] = Object.freeze([]);
export const UiArtifactSuppressionContext = createContext<readonly string[]>(EMPTY_UI_ARTIFACT_PATHS);

/** Context broadcasts only when the suppressed paths change, including cloned messages. */
export function useUiArtifactSuppressionPaths(paths: readonly string[]): readonly string[] {
  const previous = useRef(EMPTY_UI_ARTIFACT_PATHS);
  if (paths.length !== previous.current.length || paths.some((path, index) => path !== previous.current[index])) {
    previous.current = paths.length ? paths : EMPTY_UI_ARTIFACT_PATHS;
  }
  return previous.current;
}
