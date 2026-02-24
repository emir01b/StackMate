import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, File, Folder, RefreshCw, Edit3, Trash2, FilePlus, FolderPlus } from 'lucide-react';
import { apiReadFile } from '../utils/fileApi';
import './FileExplorer.css';

const FileExplorer = ({ onFileSelect, customFiles, onRefresh, onRename, onDelete, onNewFile, onNewFolder, currentDirPath }) => {
  const [expanded, setExpanded] = useState(new Set());
  const [fileStructure, setFileStructure] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null); // Seçili dosya/klasör

  useEffect(() => {
    if (customFiles) {
      setFileStructure(customFiles);
      setExpanded(new Set([customFiles.name]));
    } else {
      setFileStructure(null);
    }
  }, [customFiles]);

  const loadFolderContents = async (node, path) => {
    // Handle yoksa (fallback mod) veya children zaten varsa atla
    if (!node.handle || node.children.length > 0) return;
    try {
      const entries = [];
      for await (const entry of node.handle.values()) {
        entries.push({
          name: entry.name,
          type: entry.kind === 'directory' ? 'folder' : 'file',
          handle: entry,
          ...(entry.kind === 'directory' && { children: [] }),
        });
      }
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      setFileStructure(prev => {
        const updateNode = (node) => {
          if (node.handle === entries[0]?.handle?.parent) return node;
          const lastName = path.split('/').pop();
          if (node.name === lastName && node.type === 'folder') {
            return { ...node, children: entries };
          }
          if (node.children) {
            return { ...node, children: node.children.map(updateNode) };
          }
          return node;
        };
        // Daha güvenilir: handle referansı ile eşleştir
        const updateByHandle = (current) => {
          if (current.handle === node.handle) return { ...current, children: entries };
          if (current.children) return { ...current, children: current.children.map(updateByHandle) };
          return current;
        };
        return updateByHandle(prev);
      });
    } catch (err) {
      console.error('Klasör yüklenemedi:', err.message);
    }
  };

  const toggleFolder = async (path, node) => {
    const newExpanded = new Set(expanded);
    if (newExpanded.has(path)) {
      newExpanded.delete(path);
    } else {
      newExpanded.add(path);
      await loadFolderContents(node, path);
    }
    setExpanded(newExpanded);
  };

  const handleFileClick = async (node, nodePath) => {
    if (node.type === 'folder') return;

    if (node.handle) {
      // Native FS — File System Access API
      try {
        const file = await node.handle.getFile();
        const content = await file.text();
        onFileSelect({ name: node.name, content, handle: node.handle });
      } catch (err) {
        console.error('Dosya okunamadı:', err.message);
        alert('Dosya okunamadı: ' + err.message);
      }
    } else if (node._file) {
      // Fallback — <input webkitdirectory> ile gelen File nesnesi
      try {
        const content = await node._file.text();
        onFileSelect({ name: node.name, content, handle: null, _file: node._file });
      } catch (err) {
        console.error('Dosya okunamadı:', err.message);
        alert('Dosya okunamadı: ' + err.message);
      }
    } else if (currentDirPath) {
      // Backend API — sunucudan dosya içeriğini oku
      try {
        const parts = nodePath.split('/');
        parts.shift(); // root klasör adını kaldır
        const relativePath = parts.join('\\');
        const fullPath = currentDirPath + '\\' + relativePath;
        const result = await apiReadFile(fullPath);
        onFileSelect({ name: node.name, content: result.content, handle: null });
      } catch (err) {
        console.error('Dosya okunamadı:', err.message);
        alert('Dosya okunamadı: ' + err.message);
      }
    } else {
      onFileSelect({ name: node.name, content: node.content || '' });
    }
  };

  const FileTreeNode = ({ node, path = '', level = 0 }) => {
    const currentPath = path ? `${path}/${node.name}` : node.name;
    const isExpanded = expanded.has(currentPath);
    const isFolder = node.type === 'folder';
    const isSelected = selectedNode?.path === currentPath;

    const handleClick = (e) => {
      e.stopPropagation();
      // Seçili yap
      setSelectedNode({ name: node.name, path: currentPath, type: node.type });
      // Klasörse aç/kapat, dosyaysa dosya aç
      if (isFolder) {
        toggleFolder(currentPath, node);
      } else {
        handleFileClick(node, currentPath);
      }
    };

    return (
      <div>
        <div
          className={`file-tree-node ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          onClick={handleClick}
        >
          {isFolder ? (
            <>
              {isExpanded ? <ChevronDown className="icon chevron" /> : <ChevronRight className="icon chevron" />}
              <Folder className="icon folder-icon" />
            </>
          ) : (
            <>
              <div className="icon-spacer" />
              <File className="icon file-icon" />
            </>
          )}
          <span className="node-name">{node.name}</span>
        </div>
        {isFolder && isExpanded && node.children && (
          <div>
            {node.children.length === 0 ? (
              <div style={{ paddingLeft: `${(level + 1) * 16 + 24}px`, fontSize: '12px', color: '#858585', padding: '4px 8px' }}>
                Yükleniyor...
              </div>
            ) : (
              node.children.map((child, index) => (
                <FileTreeNode key={`${currentPath}/${child.name}-${index}`} node={child} path={currentPath} level={level + 1} />
              ))
            )}
          </div>
        )}
      </div>
    );
  };

  if (!fileStructure) {
    return (
      <div className="file-explorer-container">
        <div className="file-explorer-header">
          <span>EXPLORER</span>
          <div className="explorer-header-actions">
            {onNewFile && (
              <button className="explorer-action-btn" onClick={onNewFile} title="Yeni Dosya">
                <FilePlus size={14} />
              </button>
            )}
            {onNewFolder && (
              <button className="explorer-action-btn" onClick={onNewFolder} title="Yeni Klasör">
                <FolderPlus size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="explorer-empty">
          <p>Henüz klasör açılmadı.</p>
          <p><strong>File → Klasör Aç</strong> ile başlayın.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="file-explorer-container">
      <div className="file-explorer-header">
        <span className="explorer-title">{fileStructure.name.toUpperCase()}</span>
        <div className="explorer-header-actions">
          {onNewFile && (
            <button
              className="explorer-action-btn"
              onClick={onNewFile}
              title="Yeni Dosya"
            >
              <FilePlus size={14} />
            </button>
          )}
          {onNewFolder && (
            <button
              className="explorer-action-btn"
              onClick={onNewFolder}
              title="Yeni Klasör"
            >
              <FolderPlus size={14} />
            </button>
          )}
          {selectedNode && onRename && (
            <button
              className="explorer-action-btn"
              onClick={() => onRename(selectedNode)}
              title={`Yeniden Adlandır: ${selectedNode.name}`}
            >
              <Edit3 size={14} />
            </button>
          )}
          {selectedNode && onDelete && (
            <button
              className="explorer-action-btn delete-btn"
              onClick={() => onDelete(selectedNode)}
              title={`Sil: ${selectedNode.name}`}
            >
              <Trash2 size={14} />
            </button>
          )}
          {onRefresh && (
            <button className="explorer-action-btn" onClick={onRefresh} title="Yenile">
              <RefreshCw size={14} />
            </button>
          )}
        </div>
      </div>
      <FileTreeNode node={fileStructure} />
    </div>
  );
};

export default FileExplorer;
