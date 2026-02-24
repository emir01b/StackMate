import React, { useState, useEffect } from 'react';
import { GitBranch, AlertCircle, AlertTriangle, Bell, Zap, CheckCircle2 } from 'lucide-react';
import './StatusBar.css';

const getLanguageFromFilename = (filename) => {
  if (!filename) return 'Düz Metin';
  const ext = filename.split('.').pop()?.toLowerCase();
  const map = {
    js: 'JavaScript', jsx: 'JavaScript React', ts: 'TypeScript', tsx: 'TypeScript React',
    py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', cs: 'C#', cpp: 'C++', c: 'C',
    html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
    json: 'JSON', yaml: 'YAML', yml: 'YAML', xml: 'XML', toml: 'TOML',
    md: 'Markdown', mdx: 'MDX', txt: 'Düz Metin', sh: 'Shell Script',
    ps1: 'PowerShell', bat: 'Batch', cmd: 'Batch', sql: 'SQL',
    php: 'PHP', rb: 'Ruby', swift: 'Swift', kt: 'Kotlin', dart: 'Dart',
    vue: 'Vue', svelte: 'Svelte', astro: 'Astro', graphql: 'GraphQL',
    dockerfile: 'Dockerfile', gitignore: 'Git Ignore', env: 'Env',
  };
  return map[ext] || ext?.toUpperCase() || 'Düz Metin';
};

const StatusBar = ({ activeFile, gitBranch = 'main', cursorPos = { line: 1, col: 1 }, errors = 0, warnings = 0 }) => {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  const language = getLanguageFromFilename(activeFile?.name);
  const timeStr = time.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="status-bar">
      <div className="status-left">
        <span className="status-item status-branch" title="Branch">
          <GitBranch size={13} />
          <span>{gitBranch}</span>
        </span>

        <span className={`status-item ${errors > 0 ? 'status-error' : ''}`} title={`${errors} Hata`}>
          <AlertCircle size={13} />
          <span>{errors}</span>
        </span>

        <span className={`status-item ${warnings > 0 ? 'status-warning' : ''}`} title={`${warnings} Uyarı`}>
          <AlertTriangle size={13} />
          <span>{warnings}</span>
        </span>

        {errors === 0 && warnings === 0 && (
          <span className="status-item status-ok" title="Sorun yok">
            <CheckCircle2 size={13} />
          </span>
        )}
      </div>

      <div className="status-right">
        {activeFile && (
          <>
            <span className="status-item" title="Satır ve Sütun">
              Satır {cursorPos.line}, Sütun {cursorPos.col}
            </span>
            <span className="status-item status-separator">|</span>
            <span className="status-item" title="Girinti">
              Boşluklar: 2
            </span>
            <span className="status-item status-separator">|</span>
            <span className="status-item" title="Dosya kodlaması">
              UTF-8
            </span>
            <span className="status-item status-separator">|</span>
            <span className="status-item status-lang" title={`Dil: ${language}`}>
              {language}
            </span>
            <span className="status-item status-separator">|</span>
          </>
        )}

        <span className="status-item status-brand" title="StackMate Web IDE">
          <Zap size={12} />
          <span>StackMate</span>
        </span>

        <span className="status-item status-separator">|</span>

        <button
          className="status-item clickable"
          title="Bildirimleri Görüntüle"
          onClick={() => alert('Bildirim yok.')}
        >
          <Bell size={12} />
        </button>

        <span className="status-item status-time" title="Saat">
          {timeStr}
        </span>
      </div>
    </div>
  );
};

export default StatusBar;
