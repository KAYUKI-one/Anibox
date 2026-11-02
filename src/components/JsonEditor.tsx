import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
};
loader.config({ monaco }); // Bundle locally: configuration content never goes to a CDN.
monaco.editor.defineTheme('anibox', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'string.key.json', foreground: '436283' },
    { token: 'string.value.json', foreground: '18716F' },
    { token: 'number', foreground: '875323' },
  ],
  colors: {
    'editor.background': '#00000000',
    'editorGutter.background': '#00000000',
    'editor.lineHighlightBackground': '#EAF3FA',
    'editorLineNumber.foreground': '#B1BDCB',
    'editor.selectionBackground': '#D2EAF9',
  },
});

export default function JsonEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <Editor
      language="json"
      theme="anibox"
      value={value}
      onChange={(text) => onChange?.(text ?? '')}
      loading={<div className="editor-loading">正在准备配置编辑器…</div>}
      options={{
        ariaLabel: 'JSON 配置源代码',
        readOnly,
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: 'Cascadia Code, Consolas, monospace',
        fontSize: 13,
        lineHeight: 24,
        tabSize: 2,
        scrollBeyondLastLine: false,
        padding: { top: 20, bottom: 20 },
        renderLineHighlight: 'line',
        folding: true,
        wordWrap: 'on',
        smoothScrolling: true,
        fixedOverflowWidgets: true,
      }}
    />
  );
}
