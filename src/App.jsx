import React, { useState, useEffect, useRef } from 'react';
import Navbar from './components/Navbar';
import FileExplorer from './components/FileExplorer';
import CodeEditor from './components/CodeEditor';
import TabBar from './components/TabBar';
import AIPanel from './components/AIPanel';
import Terminal from './components/Terminal';
import ErrorBoundary from './components/ErrorBoundary';
import ResizeHandle from './components/ResizeHandle';
import {
  saveDirectoryHandle, loadDirectoryHandle,
  saveOpenFileHandles, loadOpenFileHandles,
  saveActiveTab, loadActiveTab,
  saveTerminalState, loadTerminalState,
  savePanelSizes, loadPanelSizes,
} from './utils/storage';
import './App.css';

// Klasör içeriğini oku (sadece ilk seviye, lazy load için)
const readDirectory = async (dirHandle) => {
  const entries = [];
  for await (const entry of dirHandle.values()) {
    entries.push({
      name: entry.name,
      type: entry.kind === 'directory' ? 'folder' : 'file',
      handle: entry,
      children: entry.kind === 'directory' ? [] : undefined,
    });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { name: dirHandle.name, type: 'folder', children: entries, handle: dirHandle };
};

function App() {
  const [files, setFiles] = useState(null);
  const [currentDirHandle, setCurrentDirHandle] = useState(null);

  // Tab sistemi
  const [openTabs, setOpenTabs] = useState([]); // [{ name, content, handle, modified }]
  const [activeTab, setActiveTab] = useState(null); // aktif tab'ın name'i

  const [showExplorer, setShowExplorer] = useState(true);
  const [showAI, setShowAI] = useState(true);
  const [showTerminal, setShowTerminal] = useState(false);

  // Panel boyutları (piksel cinsinden)
  const [explorerWidth, setExplorerWidth] = useState(null);
  const [aiWidth, setAIWidth] = useState(null);
  const [terminalHeight, setTerminalHeight] = useState(null);

  // Aktif tab'ın dosya objesi
  const activeFile = openTabs.find(t => t.name === activeTab) || null;
  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;

  // ─── BAŞLANGIÇ: Kayıtlı state'i geri yükle ───────────────────────────────
  useEffect(() => {
    const restore = async () => {
      // Terminal durumunu geri yükle
      setShowTerminal(loadTerminalState());

      // Panel boyutlarını geri yükle
      const savedSizes = loadPanelSizes();
      if (savedSizes) {
        if (savedSizes.explorerWidth) setExplorerWidth(savedSizes.explorerWidth);
        if (savedSizes.aiWidth) setAIWidth(savedSizes.aiWidth);
        if (savedSizes.terminalHeight) setTerminalHeight(savedSizes.terminalHeight);
      }

      // Son klasörü geri yükle
      const dirHandle = await loadDirectoryHandle();
      if (!dirHandle) return;
      try {
        const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
        const granted = perm === 'granted'
          || (await dirHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
        if (!granted) return;

        const structure = await readDirectory(dirHandle);
        setFiles(structure);
        setCurrentDirHandle(dirHandle);

        // Açık dosyaları geri yükle
        const savedHandles = await loadOpenFileHandles();
        const savedActiveTab = await loadActiveTab();
        if (savedHandles && savedHandles.length > 0) {
          const restoredTabs = [];
          for (const h of savedHandles) {
            try {
              const fp = await h.queryPermission({ mode: 'readwrite' });
              if (fp === 'granted' || (await h.requestPermission({ mode: 'readwrite' })) === 'granted') {
                const f = await h.getFile();
                const content = await f.text();
                restoredTabs.push({ name: h.name, content, handle: h, modified: false });
              }
            } catch (_) { /* dosya erişilemez, atla */ }
          }
          if (restoredTabs.length > 0) {
            setOpenTabs(restoredTabs);
            const activeExists = restoredTabs.find(t => t.name === savedActiveTab);
            setActiveTab(activeExists ? savedActiveTab : restoredTabs[0].name);
          }
        }
      } catch (_) {
        // State geri yükleme sessizce atlanır
      }
    };
    restore();
  }, []);

  // ─── TAB İŞLEMLERİ ────────────────────────────────────────────────────────
  const openFileInTab = async (fileObj) => {
    // Zaten açıksa sadece aktif yap
    const existing = openTabs.find(t => t.name === fileObj.name);
    if (existing) {
      setActiveTab(fileObj.name);
      await saveActiveTab(fileObj.name);
      return;
    }

    // İçeriği oku
    let content = fileObj.content || '';
    if (fileObj.handle && !fileObj.content) {
      try {
        const f = await fileObj.handle.getFile();
        content = await f.text();
      } catch (e) { content = ''; }
    }

    const newTab = { name: fileObj.name, content, handle: fileObj.handle, modified: false };
    const newTabs = [...openTabs, newTab];
    setOpenTabs(newTabs);
    setActiveTab(fileObj.name);

    // Kaydet
    await saveActiveTab(fileObj.name);
    const handles = newTabs.filter(t => t.handle).map(t => t.handle);
    await saveOpenFileHandles(handles);
  };

  const closeTab = async (tab) => {
    const newTabs = openTabs.filter(t => t.name !== tab.name);
    setOpenTabs(newTabs);
    if (activeTab === tab.name) {
      const newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].name : null;
      setActiveTab(newActive);
      await saveActiveTab(newActive);
    }
    const handles = newTabs.filter(t => t.handle).map(t => t.handle);
    await saveOpenFileHandles(handles);
  };

  const handleTabClick = async (tab) => {
    setActiveTab(tab.name);
    await saveActiveTab(tab.name);
  };

  // CodeEditor içerik kaydedildiğinde tab'ı güncelle
  const handleSave = (savedContent) => {
    setOpenTabs(prev => prev.map(t =>
      t.name === activeTab ? { ...t, content: savedContent, modified: false } : t
    ));
  };

  // ─── RESIZE HANDLERS ──────────────────────────────────────────────────────
  const explorerRef = useRef(null);
  const aiRef = useRef(null);
  const terminalRef = useRef(null);

  const handleExplorerResize = (newWidth) => {
    const min = 150;
    const max = 600;
    const clamped = Math.max(min, Math.min(max, newWidth));
    setExplorerWidth(clamped);
    savePanelSizes({ explorerWidth: clamped, aiWidth, terminalHeight });
  };

  const handleAIResize = (newWidth) => {
    const min = 200;
    const max = 800;
    const clamped = Math.max(min, Math.min(max, newWidth));
    setAIWidth(clamped);
    savePanelSizes({ explorerWidth, aiWidth: clamped, terminalHeight });
  };

  const handleTerminalResize = (newHeight) => {
    const min = 100;
    const max = window.innerHeight * 0.7;
    const clamped = Math.max(min, Math.min(max, newHeight));
    setTerminalHeight(clamped);
    savePanelSizes({ explorerWidth, aiWidth, terminalHeight: clamped });
  };

  const getExplorerResizeStart = () => {
    return explorerRef.current?.offsetWidth || 0;
  };

  const getAIResizeStart = () => {
    return aiRef.current?.offsetWidth || 0;
  };

  const getTerminalResizeStart = () => {
    return terminalRef.current?.offsetHeight || 0;
  };

  // ─── FILE / VIEW ACTION ────────────────────────────────────────────────────
  const handleFileAction = async (action) => {
    switch (action) {
      case 'open-folder': {
        if (!('showDirectoryPicker' in window)) {
          alert('Chrome veya Edge kullanın (File System Access API gerekli).');
          return;
        }
        try {
          const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
          const structure = await readDirectory(dirHandle);
          setFiles(structure);
          setCurrentDirHandle(dirHandle);
          await saveDirectoryHandle(dirHandle);
        } catch (err) {
          if (err.name !== 'AbortError') alert('Klasör açılamadı: ' + err.message);
        }
        break;
      }
      case 'open-file': {
        if (!('showOpenFilePicker' in window)) {
          alert('Chrome veya Edge kullanın.');
          return;
        }
        try {
          const [fh] = await window.showOpenFilePicker();
          const f = await fh.getFile();
          const content = await f.text();
          await openFileInTab({ name: f.name, content, handle: fh });
        } catch (err) {
          if (err.name !== 'AbortError') alert('Dosya açılamadı: ' + err.message);
        }
        break;
      }
      case 'save-file': {
        const current = activeFileRef.current;
        if (!current?.handle) {
          alert('Kaydedilecek açık dosya yok.');
          return;
        }
        try {
          // Monaco editör Ctrl+S ile zaten kendi içinde kaydeder
          // Burası File menüsünden kaydet için fallback
          const writable = await current.handle.createWritable();
          await writable.write(current.content || '');
          await writable.close();
          handleSave(current.content || '');
        } catch (err) {
          alert('Kaydetme hatası: ' + err.message);
        }
        break;
      }
      case 'new-file': {
        const name = 'untitled-' + Date.now() + '.txt';
        const newTab = { name, content: '', handle: null, modified: false };
        const newTabs = [...openTabs, newTab];
        setOpenTabs(newTabs);
        setActiveTab(name);
        await saveActiveTab(name);
        break;
      }
      default:
        break;
    }
  };

  const handleViewAction = async (action) => {
    switch (action) {
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
      case 'fullscreen':
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen();
        break;
      default: break;
    }
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div className="app-root">
      <Navbar onFileAction={handleFileAction} onViewAction={handleViewAction} />

      <div className="app-main">
        <div className="app-container">
          {showExplorer && (
            <>
              <div 
                ref={explorerRef}
                className="file-explorer"
                style={{ width: explorerWidth ? `${explorerWidth}px` : undefined }}
              >
                <FileExplorer
                  onFileSelect={openFileInTab}
                  customFiles={files}
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
                <AIPanel />
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
                  onClose={() => { setShowTerminal(false); saveTerminalState(false); }}
                  workingDirectory={currentDirHandle?.name || null}
                />
              </ErrorBoundary>
            </div>
          </>
        )}
      </div>
      </div>
  );
}

export default App;
