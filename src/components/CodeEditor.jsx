import React, { useRef, useCallback, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { Save } from 'lucide-react';
import { apiSaveFile } from '../utils/fileApi';
import { joinProjectPath } from '../utils/paths';
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
  const pendingSaveRef = useRef(null);

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

  const saveContent = useCallback(async (targetFile, content) => {
    if (targetFile?.handle) {
      try {
        const writable = await targetFile.handle.createWritable();
        await writable.write(content);
        await writable.close();
        onSave?.(content, targetFile.id);
        showToast('✓ Kaydedildi');
      } catch (err) {
        showToast('✗ ' + err.message, true);
      }
    } else if (targetFile?.relativePath && currentDirPath) {
      try {
        await apiSaveFile(joinProjectPath(currentDirPath, targetFile.relativePath), content);
        onSave?.(content, targetFile.id);
        showToast('✓ Kaydedildi');
      } catch (err) {
        showToast('✗ ' + err.message, true);
      }
    } else if (targetFile) {
      try {
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = targetFile.name || 'untitled.txt';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        onSave?.(content, targetFile.id);
        showToast('✓ İndirildi (tarayıcı kısıtlaması)');
      } catch (err) {
        showToast('✗ ' + err.message, true);
      }
    } else {
      showToast('✗ Kaydedilecek açık dosya yok', true);
    }
  }, [onSave, currentDirPath]);

  const doSave = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    clearTimeout(contentChangeTimerRef.current);
    pendingSaveRef.current = null;
    return saveContent(file, editor.getValue());
  }, [file, saveContent]);

  // Monaco komutu yalnızca mount anında kaydedilir; güncel doSave'e ref üzerinden ulaşılır.
  const doSaveRef = useRef(doSave);
  useEffect(() => { doSaveRef.current = doSave; }, [doSave]);

  const handleEditorChange = useCallback((value) => {
    if (contentChangeTimerRef.current) clearTimeout(contentChangeTimerRef.current);
    onContentChange?.(value);
    // Diske bağlı olmayan sekmeler (Adsız, salt okunur dosya) otomatik kaydedilmez; aksi halde her tuşta indirme başlar.
    if (editorSettings?.autoSave !== false && (file?.relativePath || file?.handle)) {
      pendingSaveRef.current = { file, content: value };
      contentChangeTimerRef.current = setTimeout(() => doSaveRef.current(), editorSettings?.autoSaveDelay || 1000);
    }
  }, [onContentChange, file, editorSettings?.autoSave, editorSettings?.autoSaveDelay]);

  // Sekme değişince bekleyen otomatik kaydetmeyi iptal etmek yerine hemen uygula.
  const saveContentRef = useRef(saveContent);
  useEffect(() => { saveContentRef.current = saveContent; }, [saveContent]);
  useEffect(() => () => {
    clearTimeout(contentChangeTimerRef.current);
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) saveContentRef.current(pending.file, pending.content);
  }, [file?.id]);

  const handleMount = useCallback((editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => doSaveRef.current());
    editor.onDidChangeCursorPosition((e) => {
      onCursorChange?.({ line: e.position.lineNumber, col: e.position.column });
    });
    onEditorMount?.(editor);
  }, [onCursorChange, onEditorMount]);

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

  if (file.binary || file.tooLarge) {
    return (
      <div className="code-editor-container">
        <div className="editor-placeholder">
          <div className="placeholder-content">
            <div className="placeholder-icon">📦</div>
            <p className="placeholder-title">{file.name}</p>
            <p className="placeholder-subtitle">{file.binary ? 'Bu dosya ikili (metin olmayan) bir dosya; editörde gösterilemez.' : 'Bu dosya 5 MB\'tan büyük; editörde açılmadı.'}</p>
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
