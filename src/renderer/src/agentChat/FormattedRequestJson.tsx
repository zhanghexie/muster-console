import React, { useLayoutEffect, useRef } from 'react';
import { format } from 'jsonc-parser';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { json } from '@codemirror/lang-json';
import { workbenchEditorTheme, workbenchSyntaxHighlighting } from '../editor/workbenchCmTheme';

// The formatter emits ordered whitespace edits. Join slices once so large requests
// retain duplicate keys, numeric literals, key order and string escape sequences.
function indentJson(source: string): string {
  const edits = format(source, undefined, { insertSpaces: true, tabSize: 2, eol: '\n' });
  const pieces: string[] = [];
  let start = 0;
  for (const edit of edits) {
    pieces.push(source.slice(start, edit.offset), edit.content);
    start = edit.offset + edit.length;
  }
  pieces.push(source.slice(start));
  return pieces.join('');
}

export default function FormattedRequestJson({ body, label }: { body: string; label: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      doc: indentJson(body),
      extensions: [json(), lineNumbers(), EditorView.lineWrapping, workbenchEditorTheme, workbenchSyntaxHighlighting,
        EditorState.readOnly.of(true), EditorView.editable.of(false),
        EditorView.contentAttributes.of({ tabindex: '0', role: 'textbox', 'aria-label': label, 'aria-readonly': 'true', 'aria-multiline': 'true' })]
    });
    return () => view.destroy();
  }, [body, label]);
  return <div ref={host} className="request-json-editor"/>;
}
