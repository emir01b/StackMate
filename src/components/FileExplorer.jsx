import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, File, Folder } from 'lucide-react';
import './FileExplorer.css';

const FileExplorer = ({ onFileSelect, customFiles }) => {
  const [expanded, setExpanded] = useState(new Set());
  const [fileStructure, setFileStructure] = useState(null);

  useEffect(() => {
    if (customFiles) {
      setFileStructure(customFiles);
      setExpanded(new Set([customFiles.name]));
    } else {
      setFileStructure(null);
    }
  }, [customFiles]);

  const loadFolderContents = async (node, path) => {
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

  const handleFileClick = async (node) => {
    if (node.type === 'folder') return;

    if (node.handle) {
      try {
        const file = await node.handle.getFile();
        const content = await file.text();
        onFileSelect({ name: node.name, content, handle: node.handle });
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

    return (
      <div>
        <div
          className="file-tree-node"
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          onClick={() => isFolder ? toggleFolder(currentPath, node) : handleFileClick(node)}
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
        <div className="file-explorer-header">EXPLORER</div>
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
        EXPLORER — {fileStructure.name}
      </div>
      <FileTreeNode node={fileStructure} />
    </div>
  );
};

export default FileExplorer;
