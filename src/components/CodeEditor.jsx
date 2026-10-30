import React, { useRef, useCallback, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { Save } from 'lucide-react';
import { apiSaveFile } from '../utils/fileApi';
import './CodeEditor.css';

const LANGUAGE_MAP = {
  js: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', html: 'html', css: 'css',
  json: 'json', md: 'markdown', txt: 'plaintext',
  java: 'java', cpp: 'cpp', c: 'c',
  go: 'go', rs: 'rust', sh: 'shell', rb: 'ruby',
  php: 'php', yml: 'yaml', yaml: 'yaml', xml: 'xml',
};

const getLanguage = (filename) => {
  if (!filename) return 'plaintext';
  const ext = filename.split('.').pop().toLowerCase();
  return LANGUAGE_MAP[ext] || 'plaintext';
};

const safeContent = (v) => (typeof v === 'string' ? v : '');

const CodeEditor = ({ file, onSave, onContentChange, currentDirPath, onCursorChange, onEditorMount, editorSettings }) => {
  const editorRef = useRef(null);
  const saveToastRef = useRef(null);
  const contentChangeTimerRef = useRef(null);

  const showToast = (msg, isError = false) => {
    if (!saveToastRef.current) return;
    saveToastRef.current.textContent = msg;
    saveToastRef.current.className = `save-toast ${isError ? 'error' : 'success'} show`;
    clearTimeout(saveToastRef._timer);
    saveToastRef._timer = setTimeout(() => {
      if (saveToastRef.current) saveToastRef.current.className = 'save-toast';
    }, 2000);
  };

  // ─── Tüm hook'lar erken return'den ÖNCE ─────────────────────────────────

  const doSave = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const content = editor.getValue();

    if (file?.handle) {
      try {
        const writable = await file.handle.createWritable();
        await writable.write(content);
        await writable.close();
        onSave?.(content);
        showToast('✓ Kaydedildi');
      } catch (err) {
        showToast('✗ ' + err.message, true);
      }
    } else if (file && currentDirPath) {
      try {
        const relativePath = file.path ? file.path.split('/').slice(1).join('\\') : file.name;
        const filePath = currentDirPath + '\\' + relativePath;
        await apiSaveFile(filePath, content);
        onSave?.(content);
        showToast('✓ Kaydedildi');
      } catch (err) {
        showToast('✗ ' + err.message, true);
      }
    } else if (file) {
      try {
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name || 'untitled.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        onSave?.(content);
        showToast('✓ İndirildi (tarayıcı kısıtlaması)');
      } catch (err) {
        showToast('✗ ' + err.message, true);
      }
    } else {
      showToast('✗ Kaydedilecek açık dosya yok', true);
    }
  }, [file, onSave, currentDirPath]);

  const handleEditorChange = useCallback((value) => {
    if (contentChangeTimerRef.current) clearTimeout(contentChangeTimerRef.current);
    onContentChange?.(value);
    if (editorSettings?.autoSave !== false) {
      contentChangeTimerRef.current = setTimeout(doSave, editorSettings?.autoSaveDelay || 1000);
    }
  }, [onContentChange, doSave, editorSettings?.autoSave, editorSettings?.autoSaveDelay]);

  useEffect(() => () => clearTimeout(contentChangeTimerRef.current), [file?.id]);

  const handleMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, doSave);
    editor.onDidChangeCursorPosition((e) => {
      onCursorChange?.({ line: e.position.lineNumber, col: e.position.column });
    });
    onEditorMount?.(editor);
  }, [doSave, onCursorChange, onEditorMount]);

  // ─── Erken return (hook'lardan SONRA) ───────────────────────────────────
  if (!file) {
    return (
      <div className="code-editor-container">
        <div className="editor-placeholder">
          <div className="placeholder-content">
            <div className="placeholder-icon">📄</div>
            <p className="placeholder-title">Dosya seçilmedi</p>
            <p className="placeholder-subtitle">Sol panelden bir dosya seçin</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="code-editor-container">
      <div className="save-toast" ref={saveToastRef} />
      <div className="editor-toolbar">
        <span className="editor-filename">{file.name}</span>
        <span className="editor-auto-save-indicator" style={{ fontSize: '11px', color: '#888', marginLeft: 'auto', marginRight: '10px' }}>{editorSettings?.autoSave === false ? 'Ctrl+S ile kaydet' : 'Otomatik kaydet açık'}</span>
      </div>
      <div className="editor-wrapper">
        <Editor
          key={file.id || file.name}
          height="100%"
          language={getLanguage(file.name)}
          value={safeContent(file.content)}
          onMount={handleMount}
          onChange={handleEditorChange}
          theme="vs-dark"
          options={{
            fontSize: editorSettings?.fontSize || 14,
            minimap: { enabled: editorSettings?.minimap !== false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: editorSettings?.tabSize || 2,
            wordWrap: editorSettings?.wordWrap === false ? 'off' : 'on',
            renderWhitespace: 'selection',
          }}
        />
      </div>
    </div>
  );
};

export default CodeEditor;
