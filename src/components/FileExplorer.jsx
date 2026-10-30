import React, { useState, useEffect, useCallback, useRef, useMemo, forwardRef, useImperativeHandle } from 'react';
import {
  ChevronRight, ChevronDown, File, FileCode, FileJson, FileText, FileImage, Folder, FolderOpen,
  FilePlus, FolderPlus, RefreshCw, ChevronsDownUp, Link2,
} from 'lucide-react';
import { apiReadSubdir, apiCreateFile, apiMkdir, apiRename, apiDelete, apiReveal } from '../utils/fileApi';
import { joinProjectPath, validateEntryName, parentOfRelative } from '../utils/paths';
import './FileExplorer.css';

const CODE_EXT = /\.(?:jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|bat|ps1|vue|svelte|html?|css|scss|less|sql|xml|yml|yaml|toml)$/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;
const ICON_TONE = [
  [/\.(?:jsx?|mjs|cjs)$/i, 'tone-js'], [/\.tsx?$/i, 'tone-ts'], [/\.html?$/i, 'tone-html'],
  [/\.(?:css|scss|less)$/i, 'tone-css'], [/\.json$/i, 'tone-json'], [/\.md$/i, 'tone-md'], [/\.py$/i, 'tone-py'],
];

const EntryIcon = ({ entry, open }) => {
  if (entry.type === 'folder') return open ? <FolderOpen className="fe-icon tone-folder" /> : <Folder className="fe-icon tone-folder" />;
  const tone = ICON_TONE.find(([pattern]) => pattern.test(entry.name))?.[1] || 'tone-file';
  const Icon = /\.json$/i.test(entry.name) ? FileJson
    : IMAGE_EXT.test(entry.name) ? FileImage
      : CODE_EXT.test(entry.name) ? FileCode
        : /\.(?:md|txt|log|csv)$/i.test(entry.name) ? FileText : File;
  return <Icon className={`fe-icon ${tone}`} />;
};

const joinRelative = (parent, name) => (parent ? `${parent}/${name}` : name);
const isInside = (relativePath, folder) => relativePath === folder || relativePath.startsWith(`${folder}/`);

// Satır içi ad girişi (yeni dosya/klasör ve yeniden adlandırma). Enter ve odak kaybı onaylar, Escape iptal eder.
const NameInput = ({ initial = '', selectBaseName = false, onSubmit, onCancel }) => {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    el.focus();
    // Yeniden adlandırmada uzantı hariç kısmı seç (VS Code davranışı).
    const dot = selectBaseName ? initial.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, selectBaseName]);

  const finish = async (commit) => {
    if (doneRef.current) return;
    const name = value.trim();
    if (!commit || !name || name === initial) { doneRef.current = true; onCancel(); return; }
    const invalid = validateEntryName(name);
    if (invalid) { setError(invalid); return; }
    doneRef.current = true;
    try {
      await onSubmit(name);
    } catch (err) {
      doneRef.current = false;
      setError(err.message);
      inputRef.current?.focus();
    }
  };

  return (
    <span className="fe-input-wrap">
      <input
        ref={inputRef}
        className={`fe-input${error ? ' invalid' : ''}`}
        value={value}
        spellCheck={false}
        onChange={event => { setValue(event.target.value); setError(''); }}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); finish(true); }
          if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        }}
        onBlur={() => { if (error) { doneRef.current = true; onCancel(); } else finish(true); }}
        onClick={event => event.stopPropagation()}
      />
      {error && <span className="fe-input-error" role="alert">{error}</span>}
    </span>
  );
};

// Proje değiştiğinde App bileşeni key={rootPath} ile explorer'ı baştan kurar; durum projeye özeldir.
const FileExplorer = forwardRef(({
  rootPath, projectName, platform, activeRelativePath, recentProjects = [], backendOnline = true,
  onOpenFile, onEntryRenamed, onEntryDeleted, onPickFolder, onOpenRecent,
}, ref) => {
  const [dirs, setDirs] = useState({}); // göreli klasör yolu → alt öğeler
  // Bu projede açık bırakılan klasörler.
  const [expanded, setExpanded] = useState(() => {
    if (!rootPath) return new Set();
    try { return new Set(JSON.parse(localStorage.getItem(`stackmate_expanded:${rootPath}`) || '[]')); } catch { return new Set(); }
  });
  const [selected, setSelected] = useState(null); // { path, type }
  const [editing, setEditing] = useState(null); // { mode: 'file' | 'folder' | 'rename', parent, path?, name? }
  const [menu, setMenu] = useState(null); // { x, y, entry }
  const [error, setError] = useState('');
  const containerRef = useRef(null);
  const expandedRef = useRef(expanded);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);

  const storageKey = rootPath ? `stackmate_expanded:${rootPath}` : null;
  const fullPath = useCallback((relativePath) => joinProjectPath(rootPath, relativePath), [rootPath]);
  const revealLabel = platform === 'darwin' ? 'Finder\'da Göster' : platform === 'win32' ? 'Dosya Gezgini\'nde Göster' : 'Klasörde Göster';

  const loadDir = useCallback(async (relativePath) => {
    const { children } = await apiReadSubdir(fullPath(relativePath));
    setDirs(prev => ({ ...prev, [relativePath]: children }));
    return children;
  }, [fullPath]);

  // Kökü ve kayıtlı açık klasörleri yükle; artık var olmayan klasörler listeden düşer.
  useEffect(() => {
    if (!rootPath) return;
    apiReadSubdir(joinProjectPath(rootPath, ''))
      .then(({ children }) => setDirs(prev => ({ ...prev, '': children })))
      .catch(err => setError(err.message));
    expandedRef.current.forEach(relativePath => {
      apiReadSubdir(joinProjectPath(rootPath, relativePath))
        .then(({ children }) => setDirs(prev => ({ ...prev, [relativePath]: children })))
        .catch(() => setExpanded(prev => { const next = new Set(prev); next.delete(relativePath); return next; }));
    });
  }, [rootPath]);

  useEffect(() => {
    if (storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify([...expanded])); } catch { /* depolama kapalı */ }
    }
  }, [expanded, storageKey]);

  // Dışarıdan (agent, terminal, başka uygulama) gelen değişikliklerde yalnızca yüklü klasörleri yenile.
  const refreshAll = useCallback(async () => {
    if (!rootPath) return;
    const targets = ['', ...expandedRef.current];
    const results = await Promise.allSettled(targets.map(relativePath => apiReadSubdir(fullPath(relativePath))));
    const next = {};
    const missing = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') next[targets[index]] = result.value.children;
      else missing.push(targets[index]);
    });
    if (missing.includes('')) { setError(results[0].reason?.message || 'Klasör okunamadı'); return; }
    setError('');
    setDirs(next);
    if (missing.length) setExpanded(prev => new Set([...prev].filter(item => !missing.includes(item))));
  }, [rootPath, fullPath]);

  // Dosyanın klasörlerini aç ve dosyayı seçili göster (editörde başka yerden açılan dosyalar için).
  const reveal = useCallback((relativePath) => {
    if (!rootPath || !relativePath) return;
    const ancestors = relativePath.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
    const closed = ancestors.filter(folder => !expandedRef.current.has(folder));
    setSelected({ path: relativePath, type: 'file' });
    if (closed.length) {
      setExpanded(prev => new Set([...prev, ...closed]));
      closed.forEach(folder => { loadDir(folder).catch(() => {}); });
    }
    requestAnimationFrame(() => containerRef.current?.querySelector(`[data-path="${CSS.escape(relativePath)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [rootPath, loadDir]);

  const toggleFolder = useCallback(async (relativePath) => {
    if (expandedRef.current.has(relativePath)) {
      setExpanded(prev => { const next = new Set(prev); next.delete(relativePath); return next; });
      return;
    }
    setExpanded(prev => new Set(prev).add(relativePath));
    try { await loadDir(relativePath); } catch (err) { setError(err.message); }
  }, [loadDir]);

  // Yeni öğenin oluşturulacağı klasör: seçili klasör, seçili dosyanın klasörü veya kök.
  const targetFolder = useCallback((entry = selected) => {
    if (!entry) return '';
    return entry.type === 'folder' ? entry.path : parentOfRelative(entry.path);
  }, [selected]);

  const startCreate = useCallback(async (mode, entry) => {
    if (!rootPath) return;
    const parent = targetFolder(entry);
    if (parent && !expandedRef.current.has(parent)) {
      setExpanded(prev => new Set(prev).add(parent));
      try { await loadDir(parent); } catch (err) { setError(err.message); return; }
    }
    setMenu(null);
    setEditing({ mode, parent });
  }, [rootPath, targetFolder, loadDir]);

  const startRename = useCallback((entry) => {
    if (!entry?.path) return;
    setMenu(null);
    setEditing({ mode: 'rename', parent: parentOfRelative(entry.path), path: entry.path, name: entry.path.split('/').pop() });
  }, []);

  const submitCreate = useCallback(async (name) => {
    const { mode, parent } = editing;
    const isFolder = mode === 'folder' || name.endsWith('/');
    const relativePath = joinRelative(parent, name.replace(/\/+$/, ''));
    if (isFolder) await apiMkdir(fullPath(relativePath), { exclusive: true });
    else await apiCreateFile(fullPath(relativePath));
    setEditing(null);
    // "a/b/c.txt" gibi iç içe adlarda yeni öğeye giden ara klasörleri de aç.
    const ancestors = relativePath.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
    setExpanded(prev => new Set([...prev, ...ancestors]));
    await Promise.all([parent, ...ancestors].map(folder => loadDir(folder).catch(() => {})));
    setSelected({ path: relativePath, type: isFolder ? 'folder' : 'file' });
    if (!isFolder) onOpenFile?.(relativePath);
  }, [editing, fullPath, loadDir, onOpenFile]);

  const submitRename = useCallback(async (name) => {
    const { path: oldPath, parent } = editing;
    const newPath = joinRelative(parent, name);
    await apiRename(fullPath(oldPath), fullPath(newPath));
    setEditing(null);
    // Açık klasör kayıtlarını yeni ada taşı.
    setExpanded(prev => new Set([...prev].map(item => (isInside(item, oldPath) ? newPath + item.slice(oldPath.length) : item))));
    setDirs(prev => Object.fromEntries(Object.entries(prev).map(([key, value]) => [isInside(key, oldPath) ? newPath + key.slice(oldPath.length) : key, value])));
    await loadDir(parent).catch(() => {});
    setSelected(current => (current ? { ...current, path: isInside(current.path, oldPath) ? newPath + current.path.slice(oldPath.length) : current.path } : current));
    onEntryRenamed?.(oldPath, newPath);
  }, [editing, fullPath, loadDir, onEntryRenamed]);

  const deleteEntry = useCallback(async (entry) => {
    setMenu(null);
    if (!entry?.path) return;
    const name = entry.path.split('/').pop();
    const trashName = platform === 'win32' ? 'Geri Dönüşüm Kutusu\'na' : 'çöp kutusuna';
    if (!window.confirm(`"${name}" ${entry.type === 'folder' ? 'klasörü ve içindekiler' : 'dosyası'} ${trashName} taşınsın mı?`)) return;
    try {
      await apiDelete(fullPath(entry.path));
    } catch (err) {
      if (!err.data?.trashFailed || !window.confirm(`${err.message}\n\n"${name}" kalıcı olarak silinsin mi? Bu işlem geri alınamaz.`)) {
        if (!err.data?.trashFailed) setError(err.message);
        return;
      }
      try { await apiDelete(fullPath(entry.path), { permanent: true }); } catch (permanentError) { setError(permanentError.message); return; }
    }
    setExpanded(prev => new Set([...prev].filter(item => !isInside(item, entry.path))));
    setSelected(null);
    await loadDir(parentOfRelative(entry.path)).catch(() => {});
    onEntryDeleted?.(entry.path);
  }, [platform, fullPath, loadDir, onEntryDeleted]);

  const copyText = (text) => { navigator.clipboard?.writeText(text).catch(() => {}); setMenu(null); };

  const collapseAll = () => setExpanded(new Set());

  useImperativeHandle(ref, () => ({
    newFile: () => startCreate('file'),
    newFolder: () => startCreate('folder'),
    refresh: refreshAll,
    reveal,
  }), [startCreate, refreshAll, reveal]);

  // Görünür satırları düz liste olarak üret (klavye gezintisi ve tek render döngüsü için).
  const rows = useMemo(() => {
    const result = [];
    const walk = (folder, depth) => {
      if (editing && editing.mode !== 'rename' && editing.parent === folder) result.push({ kind: 'create', depth });
      const children = dirs[folder];
      if (!children) { result.push({ kind: 'loading', depth, key: `${folder}:loading` }); return; }
      if (!children.length && !(editing && editing.mode !== 'rename' && editing.parent === folder)) {
        result.push({ kind: 'empty', depth, key: `${folder}:empty` });
        return;
      }
      for (const child of children) {
        const relativePath = joinRelative(folder, child.name);
        const open = child.type === 'folder' && expanded.has(relativePath);
        result.push({ kind: 'entry', depth, entry: child, path: relativePath, open });
        if (open) walk(relativePath, depth + 1);
      }
    };
    if (rootPath) walk('', 0);
    return result;
  }, [dirs, expanded, editing, rootPath]);

  const entryRows = rows.filter(row => row.kind === 'entry');

  const handleKeyDown = (event) => {
    if (editing || !entryRows.length) return;
    const index = entryRows.findIndex(row => row.path === selected?.path);
    const current = entryRows[index];
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = entryRows[Math.min(entryRows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      setSelected({ path: next.path, type: next.entry.type });
      containerRef.current?.querySelector(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (!current) {
      return;
    } else if (event.key === 'ArrowRight' && current.entry.type === 'folder' && !current.open) {
      event.preventDefault(); toggleFolder(current.path);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (current.entry.type === 'folder' && current.open) toggleFolder(current.path);
      else if (parentOfRelative(current.path)) setSelected({ path: parentOfRelative(current.path), type: 'folder' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current.entry.type === 'folder') toggleFolder(current.path); else onOpenFile?.(current.path);
    } else if (event.key === 'F2') {
      event.preventDefault(); startRename({ path: current.path, type: current.entry.type });
    } else if (event.key === 'Delete' || (mod && event.key === 'Backspace')) {
      event.preventDefault(); deleteEntry({ path: current.path, type: current.entry.type });
    }
  };

  // Menü dışına tıklama, kaydırma veya Escape menüyü kapatır.
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    containerRef.current?.addEventListener('scroll', close);
    const container = containerRef.current;
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
      container?.removeEventListener('scroll', close);
    };
  }, [menu]);

  const openMenu = (event, entry) => {
    event.preventDefault();
    event.stopPropagation();
    if (entry) setSelected(entry);
    // Menünün pencere dışına taşmasını önle.
    setMenu({ x: Math.min(event.clientX, window.innerWidth - 230), y: Math.min(event.clientY, window.innerHeight - 290), entry });
  };

  if (!rootPath) {
    return (
      <div className="fe-container">
        <div className="fe-header"><span className="fe-title">Explorer</span></div>
        <div className="fe-welcome">
          {backendOnline ? (
            <>
              <p>Henüz bir klasör açılmadı.</p>
              <button type="button" className="fe-primary-btn" onClick={onPickFolder}>Klasör Aç</button>
            </>
          ) : (
            <p className="fe-offline">Backend'e ulaşılamıyor. Terminalde <code>npm run dev:all</code> çalıştırın.</p>
          )}
          {recentProjects.length > 0 && (
            <div className="fe-recent">
              <div className="fe-recent-title">Son açılanlar</div>
              {recentProjects.map(project => (
                <button key={project} type="button" className="fe-recent-item" onClick={() => onOpenRecent?.(project)} title={project}>
                  <span className="fe-recent-name">{project.split(/[\\/]/).filter(Boolean).pop() || project}</span>
                  <span className="fe-recent-path">{project}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const menuEntry = menu?.entry;
  return (
    <div className="fe-container">
      <div className="fe-header">
        <span className="fe-title" title={rootPath}>{projectName}</span>
        <div className="fe-actions">
          <button type="button" className="fe-action" onClick={() => startCreate('file')} title="Yeni Dosya"><FilePlus size={14} /></button>
          <button type="button" className="fe-action" onClick={() => startCreate('folder')} title="Yeni Klasör"><FolderPlus size={14} /></button>
          <button type="button" className="fe-action" onClick={refreshAll} title="Yenile"><RefreshCw size={13} /></button>
          <button type="button" className="fe-action" onClick={collapseAll} title="Tümünü Daralt"><ChevronsDownUp size={14} /></button>
        </div>
      </div>
      {error && <div className="fe-error" role="alert" onClick={() => setError('')}>{error}</div>}
      <div
        ref={containerRef}
        className="fe-tree"
        role="tree"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onContextMenu={event => openMenu(event, null)}
        onClick={() => setSelected(null)}
      >
        {rows.map((row, index) => {
          const indent = { paddingLeft: `${8 + row.depth * 12}px` };
          if (row.kind === 'loading') return <div key={row.key} className="fe-hint" style={indent}>Yükleniyor…</div>;
          if (row.kind === 'empty') return <div key={row.key} className="fe-hint" style={indent}>Boş klasör</div>;
          if (row.kind === 'create') {
            return (
              <div key={`create-${index}`} className="fe-row editing" style={indent}>
                <span className="fe-chevron" />
                {editing.mode === 'folder' ? <Folder className="fe-icon tone-folder" /> : <File className="fe-icon tone-file" />}
                <NameInput onSubmit={submitCreate} onCancel={() => setEditing(null)} />
              </div>
            );
          }
          const { entry, path: relativePath, open } = row;
          const isFolder = entry.type === 'folder';
          const renaming = editing?.mode === 'rename' && editing.path === relativePath;
          const classes = ['fe-row'];
          if (selected?.path === relativePath) classes.push('selected');
          if (!isFolder && activeRelativePath === relativePath) classes.push('active');
          if (renaming) classes.push('editing');
          return (
            <div
              key={relativePath}
              data-path={relativePath}
              className={classes.join(' ')}
              style={indent}
              role="treeitem"
              aria-expanded={isFolder ? open : undefined}
              aria-selected={selected?.path === relativePath}
              title={entry.symlink ? `${relativePath} (sembolik bağlantı)` : relativePath}
              onClick={event => {
                event.stopPropagation();
                setSelected({ path: relativePath, type: entry.type });
                containerRef.current?.focus({ preventScroll: true });
                if (isFolder) toggleFolder(relativePath); else onOpenFile?.(relativePath);
              }}
              onContextMenu={event => openMenu(event, { path: relativePath, type: entry.type })}
            >
              <span className="fe-chevron">{isFolder && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}</span>
              <EntryIcon entry={entry} open={open} />
              {renaming ? (
                <NameInput initial={editing.name} selectBaseName={!isFolder} onSubmit={submitRename} onCancel={() => setEditing(null)} />
              ) : (
                <span className="fe-name">{entry.name}</span>
              )}
              {entry.symlink && !renaming && <Link2 className="fe-symlink" size={11} />}
            </div>
          );
        })}
      </div>

      {menu && (
        <div className="fe-menu" style={{ left: menu.x, top: menu.y }} role="menu" onMouseDown={event => event.stopPropagation()}>
          {(!menuEntry || menuEntry.type === 'folder') && (
            <>
              <button type="button" role="menuitem" onClick={() => startCreate('file', menuEntry)}>Yeni Dosya</button>
              <button type="button" role="menuitem" onClick={() => startCreate('folder', menuEntry)}>Yeni Klasör</button>
              <div className="fe-menu-sep" />
            </>
          )}
          {menuEntry?.type === 'file' && (
            <>
              <button type="button" role="menuitem" onClick={() => { setMenu(null); onOpenFile?.(menuEntry.path); }}>Aç</button>
              <div className="fe-menu-sep" />
            </>
          )}
          <button type="button" role="menuitem" onClick={() => { setMenu(null); apiReveal(fullPath(menuEntry?.path || '')).catch(err => setError(err.message)); }}>{revealLabel}</button>
          <button type="button" role="menuitem" onClick={() => copyText(fullPath(menuEntry?.path || ''))}>Yolu Kopyala</button>
          {menuEntry && <button type="button" role="menuitem" onClick={() => copyText(menuEntry.path)}>Göreli Yolu Kopyala</button>}
          {menuEntry && (
            <>
              <div className="fe-menu-sep" />
              <button type="button" role="menuitem" onClick={() => startRename(menuEntry)}>Yeniden Adlandır <kbd>F2</kbd></button>
              <button type="button" role="menuitem" className="danger" onClick={() => deleteEntry(menuEntry)}>Sil <kbd>{platform === 'darwin' ? '⌘⌫' : 'Del'}</kbd></button>
            </>
          )}
        </div>
      )}
    </div>
  );
});

FileExplorer.displayName = 'FileExplorer';

export default FileExplorer;
