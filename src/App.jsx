import React, { useState, useEffect, useRef, useCallback } from 'react';
import Navbar from './components/Navbar';
import StatusBar from './components/StatusBar';
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
import { apiReadDir, apiSaveFile, apiReadFile, apiRename, apiDelete, apiMkdir } from './utils/fileApi';
import './App.css';

// Fallback: Düz dosya listesinden ağaç yapısı oluştur
const buildTreeFromFileList = (fileList) => {
  const rootName = fileList[0]?.webkitRelativePath?.split('/')[0] || 'Proje';
  const root = { name: rootName, type: 'folder', children: [], handle: null };

  for (const file of fileList) {
    const parts = file.webkitRelativePath.split('/');
    let current = root;

    for (let i = 1; i < parts.length; i++) {
      const partName = parts[i];
      const isLastPart = i === parts.length - 1;

      if (isLastPart) {
        // Dosya
        current.children.push({
          name: partName,
          type: 'file',
          handle: null,
          content: null,
          _file: file, // Orijinal File nesnesi (lazy read için)
        });
      } else {
        // Klasör
        let folder = current.children.find(c => c.name === partName && c.type === 'folder');
        if (!folder) {
          folder = { name: partName, type: 'folder', children: [], handle: null };
          current.children.push(folder);
        }
        current = folder;
      }
    }
  }

  // Sırala: klasörler önce, sonra dosyalar (alfabetik)
  const sortTree = (node) => {
    if (node.children) {
      node.children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      node.children.forEach(sortTree);
    }
  };
  sortTree(root);
  return root;
};

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
  const [currentDirPath, setCurrentDirPath] = useState(null); // Backend API için sunucu yolu

  // Tab sistemi
  const [openTabs, setOpenTabs] = useState([]); // [{ name, content, handle, modified }]
  const [activeTab, setActiveTab] = useState(null); // aktif tab'ın name'i

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

  // İçerik değiştiğinde tab'ı modified olarak işaretle
  const handleContentChange = useCallback((newContent) => {
    setOpenTabs(prev => prev.map(t =>
      t.name === activeTab ? { ...t, content: newContent, modified: true } : t
    ));
  }, [activeTab]);

  // Explorer'ı yenile + açık sekmelerin içeriklerini diskten tekrar oku
  const refreshExplorer = useCallback(async () => {
    // 1. Dosya ağacını yenile
    if (currentDirHandle) {
      try {
        const structure = await readDirectory(currentDirHandle);
        setFiles(structure);
      } catch (err) {
        console.error('Explorer yenilenemedi:', err.message);
      }
    } else if (currentDirPath) {
      try {
        const tree = await apiReadDir(currentDirPath, true);
        setFiles(tree);
      } catch (err) {
        console.error('Explorer yenilenemedi:', err.message);
      }
    }

    // 2. Açık sekmelerin içeriklerini diskten yenile
    setOpenTabs(prevTabs => {
      // Async güncelleme başlat
      (async () => {
        const updatedTabs = await Promise.all(
          prevTabs.map(async (tab) => {
            try {
              if (tab.handle) {
                // Native FS — handle ile oku
                const f = await tab.handle.getFile();
                const content = await f.text();
                return { ...tab, content, modified: false };
              } else if (currentDirPath) {
                // Backend API — sunucudan oku
                const result = await apiReadFile(currentDirPath + '\\' + tab.name);
                return { ...tab, content: result.content, modified: false };
              }
            } catch (_) {
              // Dosya silinmiş/erişilemiyor — mevcut içeriği koru
            }
            return tab;
          })
        );
        setOpenTabs(updatedTabs);
      })();
      return prevTabs;
    });
  }, [currentDirHandle, currentDirPath]);

  // ─── ANLIK DOSYA İZLEME (FILE WATCHER via SSE veya POLLING) ───────────────
  useEffect(() => {
    let eventSource;
    let fallbackInterval;

    if (currentDirPath) {
      // Backend (Node.js) üzerinden süper hızlı anlık izleyici
      eventSource = new EventSource(`http://localhost:3001/api/fs-watch?path=${encodeURIComponent(currentDirPath)}`);
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === 'fs-change') {
            refreshExplorer();
          }
        } catch (err) { }
      };
    } else if (currentDirHandle) {
      // Tarayıcı Native File System Api kullananlar için arka planda düzenli tarama (10 saniye)
      fallbackInterval = setInterval(() => {
        refreshExplorer();
      }, 10000);
    }

    return () => {
      if (eventSource) eventSource.close();
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  }, [currentDirPath, currentDirHandle, refreshExplorer]);

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

  // ─── DOSYA YENİDEN ADLANDIR ─────────────────────────────────────────
  const handleRename = useCallback(async (node) => {
    const newName = prompt('Yeni adı girin:', node.name);
    if (!newName || !newName.trim() || newName.trim() === node.name) return;
    const trimmed = newName.trim();

    if (currentDirPath) {
      try {
        // node.path: "ProjeAdı/Alt/dosya.txt" gibi
        // root kısmını kaldırıp tam yolu oluştur
        const parts = node.path.split('/');
        parts.shift(); // root klasör adını kaldır
        const relativePath = parts.join('\\');
        const oldFullPath = currentDirPath + '\\' + relativePath;

        // Yeni tam yol: parent dizin + yeni ad
        const parentParts = [...parts];
        parentParts.pop();
        const parentDir = parentParts.length > 0
          ? currentDirPath + '\\' + parentParts.join('\\')
          : currentDirPath;
        const newFullPath = parentDir + '\\' + trimmed;

        await apiRename(oldFullPath, newFullPath);

        // Eğer açık bir sekmeyse tab adını da güncelle
        setOpenTabs(prev => prev.map(t =>
          t.name === node.name ? { ...t, name: trimmed } : t
        ));
        if (activeTab === node.name) {
          setActiveTab(trimmed);
        }

        await refreshExplorer();
      } catch (err) {
        alert('Yeniden adlandırma hatası: ' + err.message);
      }
    }
  }, [currentDirPath, activeTab, refreshExplorer]);

  // ─── DOSYA SİL ─────────────────────────────────────────────────────
  const handleDelete = useCallback(async (node) => {
    const typeText = node.type === 'folder' ? 'klasörü' : 'dosyayı';
    if (!confirm(`"${node.name}" ${typeText} silmek istediğinize emin misiniz?`)) return;

    if (currentDirPath) {
      try {
        const parts = node.path.split('/');
        parts.shift();
        const relativePath = parts.join('\\');
        const fullPath = currentDirPath + '\\' + relativePath;

        await apiDelete(fullPath);

        // Açık sekmeyse kapat
        setOpenTabs(prev => prev.filter(t => t.name !== node.name));
        if (activeTab === node.name) {
          setActiveTab(null);
        }

        await refreshExplorer();
      } catch (err) {
        alert('Silme hatası: ' + err.message);
      }
    }
  }, [currentDirPath, activeTab, refreshExplorer]);

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
  // Gizli input referansları (fallback için)
  const folderInputRef = useRef(null);
  const fileInputRef = useRef(null);

  const handleFileAction = async (action) => {
    switch (action) {
      case 'open-folder': {
        // Önce native API'yi dene (Chrome, Edge ve bazı Brave sürümleri)
        if ('showDirectoryPicker' in window) {
          try {
            const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            const structure = await readDirectory(dirHandle);
            setFiles(structure);
            setCurrentDirHandle(dirHandle);
            await saveDirectoryHandle(dirHandle);
            break; // Başarılı — çık
          } catch (err) {
            if (err.name === 'AbortError') break; // Kullanıcı iptal etti
            // API var ama çalışmıyor — fallback'e düş
            console.warn('showDirectoryPicker başarısız, fallback kullanılıyor:', err.message);
          }
        }
        // Fallback: <input webkitdirectory>
        folderInputRef.current?.click();
        break;
      }
      case 'open-file': {
        // Önce native API'yi dene
        if ('showOpenFilePicker' in window) {
          try {
            const [fh] = await window.showOpenFilePicker();
            const f = await fh.getFile();
            const content = await f.text();
            await openFileInTab({ name: f.name, content, handle: fh });
            break; // Başarılı — çık
          } catch (err) {
            if (err.name === 'AbortError') break; // Kullanıcı iptal etti
            console.warn('showOpenFilePicker başarısız, fallback kullanılıyor:', err.message);
          }
        }
        // Fallback: normal <input type="file">
        fileInputRef.current?.click();
        break;
      }
      case 'save-file': {
        const current = activeFileRef.current;
        if (!current) {
          alert('Kaydedilecek açık dosya yok.');
          return;
        }
        if (current.handle) {
          // Native FS — doğrudan kaydet
          try {
            const writable = await current.handle.createWritable();
            await writable.write(current.content || '');
            await writable.close();
            handleSave(current.content || '');
          } catch (err) {
            alert('Kaydetme hatası: ' + err.message);
          }
        } else if (currentDirPath) {
          // Backend API — sunucu üzerinden proje klasörüne kaydet
          try {
            const filePath = currentDirPath + '\\' + current.name;
            await apiSaveFile(filePath, current.content || '');
            handleSave(current.content || '');
          } catch (err) {
            alert('Kaydetme hatası: ' + err.message);
          }
        } else {
          // Fallback: dosyayı indir
          try {
            const blob = new Blob([current.content || ''], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = current.name || 'untitled.txt';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            handleSave(current.content || '');
          } catch (err) {
            alert('İndirme hatası: ' + err.message);
          }
        }
        break;
      }
      case 'new-file': {
        const fileName = prompt('Dosya adını girin:', 'yeni-dosya.txt');
        if (!fileName || !fileName.trim()) break;
        const trimmedName = fileName.trim();

        if (currentDirHandle) {
          // Native FS — proje klasörüne gerçek dosya oluştur
          try {
            const fileHandle = await currentDirHandle.getFileHandle(trimmedName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write('');
            await writable.close();
            await refreshExplorer();
            await openFileInTab({ name: trimmedName, content: '', handle: fileHandle });
          } catch (err) {
            alert('Dosya oluşturulamadı: ' + err.message);
          }
        } else if (currentDirPath) {
          // Backend API — sunucu üzerinden dosya oluştur
          try {
            const filePath = currentDirPath + '\\' + trimmedName;
            await apiSaveFile(filePath, '');
            await refreshExplorer();
            await openFileInTab({ name: trimmedName, content: '', handle: null });
          } catch (err) {
            alert('Dosya oluşturulamadı: ' + err.message);
          }
        } else {
          // Hiç klasör açılmamış — basit tab aç
          const newTab = { name: trimmedName, content: '', handle: null, modified: false };
          const newTabs = [...openTabs, newTab];
          setOpenTabs(newTabs);
          setActiveTab(trimmedName);
          await saveActiveTab(trimmedName);
        }
        break;
      }
      default:
        break;
    }
  };

  // Fallback: klasör input değişikliği
  const handleFolderInputChange = async (e) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const fileArray = Array.from(fileList);
    const tree = buildTreeFromFileList(fileArray);
    setFiles(tree);
    setCurrentDirHandle(null);

    // Dosya yolundan proje klasör yolunu çıkar (Backend API için)
    // webkitRelativePath: "SmartRamManager/dosya.txt" gibi
    // Gerçek tam yolu bulmak için backend'e sorabiliriz
    // Ama güvenlik nedeniyle tarayıcı tam yolu vermez.
    // Kullanıcıya proje yolunu soralım (bir kere)
    const rootName = fileArray[0]?.webkitRelativePath?.split('/')[0];
    if (rootName) {
      // En basit yaklaşım: kullanıcıya sor
      const savedPath = localStorage.getItem('stackmate_project_path');
      if (savedPath && savedPath.endsWith(rootName)) {
        setCurrentDirPath(savedPath);
      } else {
        const userPath = prompt(
          `Proje klasörünün tam yolunu girin (sessiz kaydetme için):\nÖrnek: C:\\Users\\kullanici\\Desktop\\proje\\${rootName}`,
          `C:\\Users\\enesb\\Desktop\\proje\\${rootName}`
        );
        if (userPath && userPath.trim()) {
          setCurrentDirPath(userPath.trim());
          localStorage.setItem('stackmate_project_path', userPath.trim());
        }
      }
    }

    // Input'u sıfırla (aynı klasör tekrar seçilebilsin)
    e.target.value = '';
  };

  // Fallback: dosya input değişikliği
  const handleFileInputChange = async (e) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const file = fileList[0];
    const content = await file.text();
    await openFileInTab({ name: file.name, content, handle: null, _file: file });
    // Input'u sıfırla
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
    } catch (_) { }
  }, []);

  const handleNewFolderInExplorer = useCallback(async () => {
    const folderName = prompt('Klasör adını girin:', 'yeni-klasör');
    if (!folderName || !folderName.trim()) return;
    const trimmed = folderName.trim();

    if (currentDirHandle) {
      try {
        await currentDirHandle.getDirectoryHandle(trimmed, { create: true });
        await refreshExplorer();
      } catch (err) {
        alert('Klasör oluşturulamadı: ' + err.message);
      }
    } else if (currentDirPath) {
      try {
        await apiMkdir(currentDirPath + '\\' + trimmed);
        await refreshExplorer();
      } catch (err) {
        alert('Klasör oluşturulamadı: ' + err.message);
      }
    }
  }, [currentDirHandle, currentDirPath, refreshExplorer]);

  const handleViewAction = useCallback(async (action) => {
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
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen();
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
      case 'new-folder-in-explorer': handleNewFolderInExplorer(); break;
      case 'quick-open': handleFileAction('open-file'); break;
      default: break;
    }
  }, [handleFileAction, handleNewFolderInExplorer, showTerminal, triggerEditorAction]);

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div className="app-root">
      <Navbar
        onFileAction={handleFileAction}
        onViewAction={handleViewAction}
        projectName={files?.name || null}
        showExplorer={showExplorer}
        showTerminal={showTerminal}
        showAI={showAI}
      />

      {/* Gizli fallback input'lar — tüm tarayıcılar için */}
      <input
        ref={folderInputRef}
        type="file"
        webkitdirectory="true"
        directory="true"
        multiple
        style={{ display: 'none' }}
        onChange={handleFolderInputChange}
      />
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />

      <div className="app-main-wrapper">
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
                    onRefresh={refreshExplorer}
                    onRename={handleRename}
                    onDelete={handleDelete}
                    onNewFile={() => handleFileAction('new-file')}
                    onNewFolder={handleNewFolderInExplorer}
                    currentDirPath={currentDirPath}
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
                  currentDirPath={currentDirPath}
                  onCursorChange={setCursorPos}
                  onEditorMount={handleEditorMount}
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
                    currentDirPath={currentDirPath}
                    projectName={files?.name}
                    openTabs={openTabs}
                    activeTab={activeTab}
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
                    onClose={() => { setShowTerminal(false); saveTerminalState(false); }}
                    workingDirectory={currentDirHandle?.name || null}
                  />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
      </div>

      <StatusBar
        activeFile={activeFile}
        gitBranch={files?.name ? 'main' : 'main'}
        cursorPos={cursorPos}
      />
    </div>
  );
}

export default App;
