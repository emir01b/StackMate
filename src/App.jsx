import React, { useState, useEffect, useRef, useCallback } from 'react';
import Navbar from './components/Navbar';
import StatusBar from './components/StatusBar';
import FileExplorer from './components/FileExplorer';
import CodeEditor from './components/CodeEditor';
import TabBar from './components/TabBar';
import AIPanel from './components/AIPanel';
import SettingsPanel from './components/SettingsPanel';
import Terminal from './components/Terminal';
import ErrorBoundary from './components/ErrorBoundary';
import ResizeHandle from './components/ResizeHandle';
import { saveTerminalState, loadTerminalState, savePanelSizes, loadPanelSizes } from './utils/storage';
import { apiOpenProject, apiPickFolder, apiReadFile, apiSaveFile } from './utils/fileApi';
import { joinProjectPath } from './utils/paths';
import './App.css';

const LAST_PROJECT_KEY = 'stackmate_verified_project_path';
const RECENT_PROJECTS_KEY = 'stackmate_recent_projects';
const tabsKey = (projectPath) => `stackmate_tabs:${projectPath}`;

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const writeJson = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* depolama kapalı olabilir */ }
};

// Proje dosyası sekmesi: kimlik "ProjeAdı/göreli/yol" biçimindedir (CodeEditor kaydederken bunu kullanır).
const makeProjectTab = (projectName, relativePath, data) => ({
  id: `${projectName}/${relativePath}`,
  path: `${projectName}/${relativePath}`,
  relativePath,
  name: relativePath.split('/').pop(),
  content: data.content || '',
  binary: !!data.binary,
  tooLarge: !!data.tooLarge,
  modified: false,
});

const isInside = (relativePath, folder) => relativePath === folder || relativePath.startsWith(`${folder}/`);

function App() {
  const [project, setProject] = useState(null); // { path, name } — gerçek (realpath) yol
  const [recentProjects, setRecentProjects] = useState(() => readJson(RECENT_PROJECTS_KEY, []));
  const [backendOnline, setBackendOnline] = useState(true);
  const [platform, setPlatform] = useState('');
  const [folderDialog, setFolderDialog] = useState(null); // { draft, error }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(null);
  const explorerRef = useRef(null);
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  useEffect(() => {
    const refresh = () => fetch('http://localhost:3001/api/settings')
      .then(response => response.ok ? response.json() : Promise.reject(new Error('Ayarlar alınamadı')))
      .then(setSettings)
      .catch(error => console.warn(error.message));
    refresh();
    window.addEventListener('stackmate-settings-changed', refresh);
    return () => window.removeEventListener('stackmate-settings-changed', refresh);
  }, []);

  const saveSettings = useCallback(async (nextSettings) => {
    const response = await fetch('http://localhost:3001/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nextSettings),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Ayarlar kaydedilemedi');
    setSettings(data);
    window.dispatchEvent(new Event('stackmate-settings-changed'));
    return data;
  }, []);

  // Tab sistemi
  const [openTabs, setOpenTabs] = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const openTabsRef = useRef(openTabs);
  useEffect(() => { openTabsRef.current = openTabs; }, [openTabs]);

  const [showExplorer, setShowExplorer] = useState(true);
  const [showAI, setShowAI] = useState(true);
  const [showTerminal, setShowTerminal] = useState(false);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });

  // Monaco editör instance (Find/Replace/Format için)
  const monacoEditorRef = useRef(null);

  // Panel boyutları (piksel cinsinden)
  const [explorerWidth, setExplorerWidth] = useState(null);
  const [aiWidth, setAIWidth] = useState(null);
  const [terminalHeight, setTerminalHeight] = useState(null);

  const activeFile = openTabs.find(t => t.id === activeTab) || null;
  const activeFileRef = useRef(activeFile);
  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);

  // ─── PROJE AÇMA ────────────────────────────────────────────────────────────
  const openProject = useCallback(async (dirPath) => {
    if (openTabsRef.current.some(tab => tab.modified)
      && !window.confirm('Kaydedilmemiş değişiklikler var. Yine de başka bir klasör açılsın mı?')) return false;
    const { path: root, name } = await apiOpenProject(dirPath);
    const projectName = name || root;
    setProject({ path: root, name: projectName });
    localStorage.setItem(LAST_PROJECT_KEY, root);
    setRecentProjects(prev => {
      const next = [root, ...prev.filter(item => item !== root)].slice(0, 8);
      writeJson(RECENT_PROJECTS_KEY, next);
      return next;
    });

    // Bu projede açık bırakılan sekmeleri geri yükle (silinmiş dosyalar atlanır).
    const saved = readJson(tabsKey(root), {});
    const tabs = [];
    for (const relativePath of Array.isArray(saved.tabs) ? saved.tabs : []) {
      try { tabs.push(makeProjectTab(projectName, relativePath, await apiReadFile(joinProjectPath(root, relativePath)))); } catch { /* dosya artık yok */ }
    }
    setOpenTabs(tabs);
    setActiveTab(tabs.find(tab => tab.relativePath === saved.active)?.id || tabs[0]?.id || null);
    return true;
  }, []);

  const showFolderDialog = useCallback((error = '') => {
    setFolderDialog({ draft: projectRef.current?.path || localStorage.getItem(LAST_PROJECT_KEY) || '', error });
  }, []);

  // İşletim sisteminin klasör seçicisi (Finder / Dosya Gezgini); kullanılamazsa yol yazma penceresine düşülür.
  const pickFolder = useCallback(async () => {
    try {
      const current = projectRef.current?.path;
      const result = await apiPickFolder(current ? current.replace(/[\\/][^\\/]+[\\/]?$/, '') : undefined);
      if (result.cancelled) return;
      await openProject(result.path);
    } catch (error) {
      if (error.status === 409) return; // Seçici zaten açık.
      showFolderDialog(error.message);
    }
  }, [openProject, showFolderDialog]);

  const openRecent = useCallback(async (projectPath) => {
    try { await openProject(projectPath); } catch (error) {
      setRecentProjects(prev => {
        const next = prev.filter(item => item !== projectPath);
        writeJson(RECENT_PROJECTS_KEY, next);
        return next;
      });
      showFolderDialog(`${projectPath}: ${error.message}`);
    }
  }, [openProject, showFolderDialog]);

  const submitFolderDialog = async (event) => {
    event.preventDefault();
    if (!folderDialog?.draft.trim()) return;
    try {
      if (await openProject(folderDialog.draft.trim())) setFolderDialog(null);
    } catch (error) {
      setFolderDialog(dialog => ({ ...dialog, error: error.message }));
    }
  };

  // ─── BAŞLANGIÇ: Backend'i bekle, son projeyi ve panel durumunu geri yükle ──
  useEffect(() => {
    setShowTerminal(loadTerminalState());
    const savedSizes = loadPanelSizes();
    if (savedSizes) {
      if (savedSizes.explorerWidth) setExplorerWidth(savedSizes.explorerWidth);
      if (savedSizes.aiWidth) setAIWidth(savedSizes.aiWidth);
      if (savedSizes.terminalHeight) setTerminalHeight(savedSizes.terminalHeight);
    }

    let cancelled = false;
    let timer;
    const connect = async () => {
      try {
        const response = await fetch('http://localhost:3001/api/os');
        const { platform: serverPlatform } = await response.json();
        if (cancelled) return;
        setPlatform(serverPlatform);
        setBackendOnline(true);
        const last = localStorage.getItem(LAST_PROJECT_KEY);
        if (last && !projectRef.current) await openProject(last).catch(() => {});
      } catch {
        if (cancelled) return;
        setBackendOnline(false);
        timer = setTimeout(connect, 3000); // Backend sonradan başlatılırsa kendiliğinden bağlan.
      }
    };
    connect();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [openProject]);

  // Açık sekmeleri proje bazında hatırla.
  useEffect(() => {
    if (!project) return;
    const projectTabs = openTabs.filter(tab => tab.relativePath);
    writeJson(tabsKey(project.path), {
      tabs: projectTabs.map(tab => tab.relativePath),
      active: projectTabs.find(tab => tab.id === activeTab)?.relativePath || null,
    });
  }, [project, openTabs, activeTab]);

  // ─── TAB İŞLEMLERİ ────────────────────────────────────────────────────────
  const addOrActivateTab = (tab) => {
    if (!openTabsRef.current.some(item => item.id === tab.id)) setOpenTabs(prev => [...prev, tab]);
    setActiveTab(tab.id);
  };

  const openProjectFile = async (relativePath) => {
    const current = projectRef.current;
    if (!current || !relativePath) return;
    const existing = openTabsRef.current.find(tab => tab.relativePath === relativePath);
    explorerRef.current?.reveal(relativePath);
    if (existing) { setActiveTab(existing.id); return; }
    try {
      addOrActivateTab(makeProjectTab(current.name, relativePath, await apiReadFile(joinProjectPath(current.path, relativePath))));
    } catch (err) {
      alert(`Dosya açılamadı: ${err.message}`);
    }
  };

  const closeTab = (tab) => {
    const remaining = openTabs.filter(t => t.id !== tab.id);
    setOpenTabs(remaining);
    if (activeTab === tab.id) setActiveTab(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
  };

  const handleTabClick = (tab) => {
    setActiveTab(tab.id);
    if (tab.relativePath) explorerRef.current?.reveal(tab.relativePath);
  };

  // CodeEditor içerik kaydedildiğinde tab'ı güncelle
  const handleSave = (savedContent, tabId = activeTab) => {
    setOpenTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, content: savedContent, modified: false } : t
    ));
  };

  // İçerik değiştiğinde tab'ı modified olarak işaretle
  const handleContentChange = useCallback((newContent) => {
    setOpenTabs(prev => prev.map(t =>
      t.id === activeTab ? { ...t, content: newContent, modified: true } : t
    ));
  }, [activeTab]);

  // Explorer'ı yenile + değiştirilmemiş açık sekmeleri diskten tekrar oku (agent veya dış değişiklikler).
  const refreshExplorer = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    explorerRef.current?.refresh();
    const refreshed = await Promise.all(openTabsRef.current
      .filter(tab => tab.relativePath && !tab.modified && !tab.binary && !tab.tooLarge)
      .map(async tab => {
        try { return { id: tab.id, content: (await apiReadFile(joinProjectPath(current.path, tab.relativePath))).content }; }
        catch { return null; } // Silinmiş dosya mevcut sekmede korunur.
      }));
    const byId = new Map(refreshed.filter(Boolean).map(item => [item.id, item.content]));
    setOpenTabs(tabs => {
      let changed = false;
      const next = tabs.map(tab => {
        if (tab.modified || !byId.has(tab.id) || byId.get(tab.id) === tab.content) return tab;
        changed = true;
        return { ...tab, content: byId.get(tab.id) };
      });
      return changed ? next : tabs;
    });
  }, []);

  // ─── ANLIK DOSYA İZLEME (SSE) ─────────────────────────────────────────────
  useEffect(() => {
    if (!project) return undefined;
    const eventSource = new EventSource(`http://localhost:3001/api/fs-watch?path=${encodeURIComponent(project.path)}`);
    eventSource.onmessage = (event) => {
      try {
        if (JSON.parse(event.data).type === 'fs-change') refreshExplorer();
      } catch { /* geçersiz olay */ }
    };
    return () => eventSource.close();
  }, [project, refreshExplorer]);

  // Explorer'da yeniden adlandırılan dosya/klasörün açık sekmelerini güncelle.
  const handleEntryRenamed = useCallback((oldPath, newPath) => {
    const current = projectRef.current;
    const renamedIds = new Map();
    const rename = (tab) => {
      if (!tab.relativePath || !isInside(tab.relativePath, oldPath)) return tab;
      const relativePath = newPath + tab.relativePath.slice(oldPath.length);
      const id = `${current.name}/${relativePath}`;
      renamedIds.set(tab.id, id);
      return { ...tab, relativePath, id, path: id, name: relativePath.split('/').pop() };
    };
    const next = openTabsRef.current.map(rename);
    setOpenTabs(next);
    setActiveTab(active => renamedIds.get(active) || active);
  }, []);

  const handleEntryDeleted = useCallback((deletedPath) => {
    const remaining = openTabsRef.current.filter(tab => !tab.relativePath || !isInside(tab.relativePath, deletedPath));
    setOpenTabs(remaining);
    setActiveTab(active => (remaining.some(tab => tab.id === active) ? active : remaining[remaining.length - 1]?.id || null));
  }, []);

  // Global Ctrl+S yakalama — tarayıcının kendi kaydet diyaloğunu engelle
  useEffect(() => {
    const handleGlobalSave = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleGlobalSave);
    return () => window.removeEventListener('keydown', handleGlobalSave);
  }, []);

  // ─── RESIZE HANDLERS ──────────────────────────────────────────────────────
  const explorerPanelRef = useRef(null);
  const aiRef = useRef(null);
  const terminalRef = useRef(null);

  const handleExplorerResize = (newWidth) => {
    const clamped = Math.max(150, Math.min(600, newWidth));
    setExplorerWidth(clamped);
    savePanelSizes({ explorerWidth: clamped, aiWidth, terminalHeight });
  };

  const handleAIResize = (newWidth) => {
    const clamped = Math.max(200, Math.min(800, newWidth));
    setAIWidth(clamped);
    savePanelSizes({ explorerWidth, aiWidth: clamped, terminalHeight });
  };

  const handleTerminalResize = (newHeight) => {
    const clamped = Math.max(100, Math.min(window.innerHeight * 0.7, newHeight));
    setTerminalHeight(clamped);
    savePanelSizes({ explorerWidth, aiWidth, terminalHeight: clamped });
  };

  const getExplorerResizeStart = () => explorerPanelRef.current?.offsetWidth || 0;
  const getAIResizeStart = () => aiRef.current?.offsetWidth || 0;
  const getTerminalResizeStart = () => terminalRef.current?.offsetHeight || 0;

  // ─── FILE / VIEW ACTION ────────────────────────────────────────────────────
  const fileInputRef = useRef(null);

  const handleFileAction = async (action) => {
    switch (action) {
      case 'open-folder':
        await pickFolder();
        break;
      case 'open-file': {
        // Proje dışı tek dosya: tarayıcının dosya seçicisiyle açılır.
        if ('showOpenFilePicker' in window) {
          try {
            const [fh] = await window.showOpenFilePicker();
            const f = await fh.getFile();
            addOrActivateTab({ id: `external:${f.name}:${f.lastModified}`, path: null, relativePath: null, name: f.name, content: await f.text(), handle: fh, modified: false, external: true });
            break;
          } catch (err) {
            if (err.name === 'AbortError') break;
            console.warn('showOpenFilePicker başarısız, fallback kullanılıyor:', err.message);
          }
        }
        fileInputRef.current?.click();
        break;
      }
      case 'save-file': {
        const current = activeFileRef.current;
        if (!current) {
          alert('Kaydedilecek açık dosya yok.');
          return;
        }
        try {
          if (current.handle) {
            const writable = await current.handle.createWritable();
            await writable.write(current.content || '');
            await writable.close();
          } else if (current.relativePath && project) {
            await apiSaveFile(joinProjectPath(project.path, current.relativePath), current.content || '');
          } else {
            // Proje dışı ve yazma izni olmayan dosya: indir.
            const url = URL.createObjectURL(new Blob([current.content || ''], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = current.name || 'untitled.txt';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }
          handleSave(current.content || '', current.id);
        } catch (err) {
          alert('Kaydetme hatası: ' + err.message);
        }
        break;
      }
      case 'new-file':
        if (project) {
          setShowExplorer(true);
          explorerRef.current?.newFile();
        } else {
          const name = `Adsız-${openTabs.length + 1}.txt`;
          addOrActivateTab({ id: `untitled:${Date.now()}`, path: null, relativePath: null, name, content: '', modified: false });
        }
        break;
      default:
        break;
    }
  };

  // Fallback: dosya input değişikliği
  const handleFileInputChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    addOrActivateTab({ id: `external:${file.name}:${file.lastModified}`, path: null, relativePath: null, name: file.name, content: await file.text(), handle: null, modified: false, external: true });
    e.target.value = '';
  };

  // Monaco editör hazır olduğunda instance'ı sakla
  const handleEditorMount = useCallback((editor) => {
    monacoEditorRef.current = editor;
  }, []);

  // Monaco editör aksiyon tetikleyici
  const triggerEditorAction = useCallback((actionId) => {
    const editor = monacoEditorRef.current;
    if (!editor) return;
    try {
      editor.getAction(actionId)?.run();
    } catch { /* eylem bu dilde yok */ }
  }, []);

  const handleViewAction = async (action) => {
    switch (action) {
      // ─── Panel toggle'ları ───────────────────────────────────────────────
      case 'toggle-explorer': setShowExplorer(v => !v); break;
      case 'toggle-ai': setShowAI(v => !v); break;
      case 'toggle-terminal': {
        const next = !showTerminal;
        setShowTerminal(next);
        saveTerminalState(next);
        break;
      }
      case 'new-terminal': {
        setShowTerminal(true);
        saveTerminalState(true);
        break;
      }
      // ─── Editör aksiyonları ──────────────────────────────────────────────
      case 'find': triggerEditorAction('actions.find'); break;
      case 'replace': triggerEditorAction('editor.action.startFindReplaceAction'); break;
      case 'format': triggerEditorAction('editor.action.formatDocument'); break;
      case 'go-to-line': triggerEditorAction('editor.action.gotoLine'); break;
      case 'go-to-symbol': triggerEditorAction('workbench.action.gotoSymbol'); break;
      case 'go-to-definition': triggerEditorAction('editor.action.revealDefinition'); break;
      case 'toggle-comment': triggerEditorAction('editor.action.commentLine'); break;
      case 'select-all': triggerEditorAction('editor.action.selectAll'); break;
      case 'undo': triggerEditorAction('undo'); break;
      case 'redo': triggerEditorAction('redo'); break;
      case 'toggle-word-wrap': triggerEditorAction('editor.action.toggleWordWrap'); break;
      case 'move-line-up': triggerEditorAction('editor.action.moveLinesUpAction'); break;
      case 'move-line-down': triggerEditorAction('editor.action.moveLinesDownAction'); break;
      case 'copy-line-up': triggerEditorAction('editor.action.copyLinesUpAction'); break;
      case 'copy-line-down': triggerEditorAction('editor.action.copyLinesDownAction'); break;
      // ─── Ekran / Görünüm ────────────────────────────────────────────────
      case 'fullscreen':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
        break;
      case 'zoom-in': {
        const cur = parseFloat(getComputedStyle(document.documentElement).fontSize);
        document.documentElement.style.fontSize = (cur * 1.1) + 'px';
        break;
      }
      case 'zoom-out': {
        const cur = parseFloat(getComputedStyle(document.documentElement).fontSize);
        document.documentElement.style.fontSize = (cur * 0.9) + 'px';
        break;
      }
      case 'zoom-reset':
        document.documentElement.style.fontSize = '';
        break;
      // ─── Terminal ────────────────────────────────────────────────────────
      case 'clear-terminal':
        // Terminal bileşeni kendi clear event'ini dinliyor
        window.dispatchEvent(new CustomEvent('terminal-clear'));
        break;
      // ─── Dosya / Explorer ─────────────────────────────────────────────
      case 'new-file-in-explorer': handleFileAction('new-file'); break;
      case 'new-folder-in-explorer':
        if (project) { setShowExplorer(true); explorerRef.current?.newFolder(); }
        break;
      case 'quick-open': handleFileAction('open-file'); break;
      default: break;
    }
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div className={`app-root density-${settings?.appearance?.density || 'comfortable'} accent-${settings?.appearance?.accent || 'blue'}`}>
      <Navbar
        onFileAction={handleFileAction}
        onViewAction={handleViewAction}
        projectName={project?.name || null}
        showExplorer={showExplorer}
        showTerminal={showTerminal}
        showAI={showAI}
        onSettings={() => setSettingsOpen(value => !value)}
        settingsOpen={settingsOpen}
      />

      {settingsOpen && <SettingsPanel settings={settings} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />}

      <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileInputChange} />

      {folderDialog && (
        <div className="folder-path-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setFolderDialog(null); }}>
          <form className="folder-path-dialog" onSubmit={submitFolderDialog} role="dialog" aria-modal="true" aria-labelledby="folder-path-title">
            <h2 id="folder-path-title">Proje klasörünü aç</h2>
            <p>Klasörün tam yolunu girin. {platform === 'win32'
              ? 'Dosya Gezgini\'nde klasöre Shift + sağ tıklayıp "Yol olarak kopyala" seçeneğini kullanabilirsiniz.'
              : 'Finder\'da klasöre sağ tıklayıp Option tuşuna basılı tutarak yolunu kopyalayabilirsiniz.'}</p>
            <input
              autoFocus
              aria-label="Klasör yolu"
              value={folderDialog.draft}
              onChange={event => setFolderDialog(dialog => ({ ...dialog, draft: event.target.value, error: '' }))}
              placeholder={platform === 'win32' ? 'C:\\Users\\kullanici\\Proje' : '/Users/kullanici/Proje'}
              spellCheck={false}
            />
            {folderDialog.error && <p className="folder-path-error" role="alert">{folderDialog.error}</p>}
            <div className="folder-path-actions">
              <button type="button" onClick={() => setFolderDialog(null)}>İptal</button>
              <button type="submit" disabled={!folderDialog.draft.trim()}>Klasörü Aç</button>
            </div>
          </form>
        </div>
      )}

      <div className="app-main-wrapper">
        <div className="app-main">
          <div className="app-container">
            {showExplorer && (
              <>
                <div
                  ref={explorerPanelRef}
                  className="file-explorer"
                  style={{ width: explorerWidth ? `${explorerWidth}px` : undefined }}
                >
                  <FileExplorer
                    key={project?.path || 'no-project'}
                    ref={explorerRef}
                    rootPath={project?.path || null}
                    projectName={project?.name || ''}
                    platform={platform}
                    activeRelativePath={activeFile?.relativePath || null}
                    recentProjects={recentProjects}
                    backendOnline={backendOnline}
                    onOpenFile={openProjectFile}
                    onEntryRenamed={handleEntryRenamed}
                    onEntryDeleted={handleEntryDeleted}
                    onPickFolder={pickFolder}
                    onOpenRecent={openRecent}
                  />
                </div>
                <ResizeHandle
                  direction="horizontal"
                  onResizeStart={getExplorerResizeStart}
                  onResize={handleExplorerResize}
                />
              </>
            )}

            <div className="code-editor">
              <TabBar
                tabs={openTabs}
                activeTab={activeTab}
                onTabClick={handleTabClick}
                onTabClose={closeTab}
              />
              <ErrorBoundary label="Editör hatası">
                <CodeEditor
                  file={activeFile}
                  onSave={handleSave}
                  onContentChange={handleContentChange}
                  currentDirPath={project?.path || null}
                  onCursorChange={setCursorPos}
                  onEditorMount={handleEditorMount}
                  editorSettings={settings?.editor}
                />
              </ErrorBoundary>
            </div>

            {showAI && (
              <>
                <ResizeHandle
                  direction="horizontal"
                  onResizeStart={getAIResizeStart}
                  onResize={handleAIResize}
                />
                <div
                  ref={aiRef}
                  className="ai-panel"
                  style={{ width: aiWidth ? `${aiWidth}px` : undefined }}
                >
                  <AIPanel
                    currentDirPath={project?.path || null}
                    currentDirHandle={null}
                    onFileChange={refreshExplorer}
                    onOpenFile={openProjectFile}
                  />
                </div>
              </>
            )}
          </div>

          {showTerminal && (
            <>
              <ResizeHandle
                direction="vertical"
                onResizeStart={getTerminalResizeStart}
                onResize={handleTerminalResize}
              />
              <div
                ref={terminalRef}
                className="terminal-panel"
                style={{ height: terminalHeight ? `${terminalHeight}px` : undefined }}
              >
                <ErrorBoundary label="Terminal hatası">
                  <Terminal
                    key={project?.path || 'no-project'}
                    onClose={() => { setShowTerminal(false); saveTerminalState(false); }}
                    workingDirectory={project?.path || null}
                  />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
      </div>

      <StatusBar
        activeFile={activeFile}
        gitBranch="main"
        cursorPos={cursorPos}
      />
    </div>
  );
}

export default App;
