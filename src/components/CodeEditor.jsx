import React, { useRef, useCallback } from 'react';
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

// Normalize: her zaman string döndür
const safeContent = (v) => (typeof v === 'string' ? v : '');

const CodeEditor = ({ file, onSave, onContentChange, currentDirPath }) => {
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

  const doSave = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;

    const content = editor.getValue();

    if (file?.handle) {
      // Native FS — doğrudan diske yaz
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
      // Backend API — sunucu üzerinden proje klasörüne kaydet
      try {
        const filePath = currentDirPath + '\\' + file.name;
        await apiSaveFile(filePath, content);
        onSave?.(content);
        showToast('✓ Kaydedildi');
      } catch (err) {
        showToast('✗ ' + err.message, true);
      }
    } else if (file) {
      // Son çare — dosyayı indir
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

  const handleMount = (editor, monaco) => {
    editorRef.current = editor;
    // Ctrl+S / Cmd+S
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, doSave);
  };

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

  // İçerik değiştiğinde üst bileşene bildir (debounced)
  const handleEditorChange = useCallback((value) => {
    if (contentChangeTimerRef.current) {
      clearTimeout(contentChangeTimerRef.current);
    }
    contentChangeTimerRef.current = setTimeout(() => {
      onContentChange?.(value);
    }, 300);
  }, [onContentChange]);

  return (
    <div className="code-editor-container">
      <div className="save-toast" ref={saveToastRef} />
      <div className="editor-toolbar">
        <span className="editor-filename">{file.name}</span>
        <button className="editor-save-btn" onClick={doSave} title="Kaydet (Ctrl+S)">
          <Save size={14} />
          <span>Kaydet</span>
        </button>
      </div>
      <div className="editor-wrapper">
        {/* key: dosya adı + içerik uzunluğu — dışarıdan içerik değiştiğinde Monaco yeniden yüklenir */}
        <Editor
          key={file.name + '::' + (file.content?.length || 0)}
          height="100%"
          language={getLanguage(file.name)}
          defaultValue={safeContent(file.content)}
          onMount={handleMount}
          onChange={handleEditorChange}
          theme="vs-dark"
          options={{
            fontSize: 14,
            minimap: { enabled: true },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            renderWhitespace: 'selection',
          }}
        />
      </div>
    </div>
  );
};

export default CodeEditor;
