import React, { useState, useEffect, useRef } from 'react';
import {
  Search, Bot, Settings, LayoutPanelLeft,
  PanelBottom, Maximize2, Minimize2, Save
} from 'lucide-react';
import './Navbar.css';

const Navbar = ({ onFileAction, onViewAction, projectName, showExplorer, showTerminal, showAI }) => {
  const [activeMenu, setActiveMenu] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const navbarRef = useRef(null);

  // label, shortcut, action(varsa), divider(varsa)
  // action yoksa → devre dışı (gri)
  const menuItems = {
    File: [
      { label: 'Yeni Dosya', shortcut: 'Ctrl+N', action: 'new-file' },
      { divider: true },
      { label: 'Klasör Aç...', shortcut: 'Ctrl+K Ctrl+O', action: 'open-folder' },
      { label: 'Dosya Aç...', shortcut: 'Ctrl+O', action: 'open-file' },
      { divider: true },
      { label: 'Farklı Kaydet...', shortcut: 'Ctrl+Shift+S', action: 'save-as' },
      { divider: true },
      { label: 'Çıkış', shortcut: 'Alt+F4' },
    ],
    Edit: [
      { label: 'Geri Al', shortcut: 'Ctrl+Z', action: 'undo' },
      { label: 'Yinele', shortcut: 'Ctrl+Y', action: 'redo' },
      { divider: true },
      { label: 'Bul', shortcut: 'Ctrl+F', action: 'find' },
      { label: 'Değiştir', shortcut: 'Ctrl+H', action: 'replace' },
      { divider: true },
      { label: 'Tümünü Seç', shortcut: 'Ctrl+A', action: 'select-all' },
      { label: 'Satırı Yukarı Taşı', shortcut: 'Alt+↑', action: 'move-line-up' },
      { label: 'Satırı Aşağı Taşı', shortcut: 'Alt+↓', action: 'move-line-down' },
      { label: 'Satırı Yukarı Kopyala', shortcut: 'Shift+Alt+↑', action: 'copy-line-up' },
      { label: 'Satırı Aşağı Kopyala', shortcut: 'Shift+Alt+↓', action: 'copy-line-down' },
      { divider: true },
      { label: 'Yorum Ekle/Kaldır', shortcut: 'Ctrl+/', action: 'toggle-comment' },
      { label: 'Kodu Biçimlendir', shortcut: 'Shift+Alt+F', action: 'format' },
    ],
    Selection: [
      { label: 'Tümünü Seç', shortcut: 'Ctrl+A', action: 'select-all' },
      { divider: true },
      { label: 'Satırı Yukarı Taşı', shortcut: 'Alt+↑', action: 'move-line-up' },
      { label: 'Satırı Aşağı Taşı', shortcut: 'Alt+↓', action: 'move-line-down' },
      { label: 'Yukarı Kopyala', shortcut: 'Shift+Alt+↑', action: 'copy-line-up' },
      { label: 'Aşağı Kopyala', shortcut: 'Shift+Alt+↓', action: 'copy-line-down' },
    ],
    View: [
      { label: 'Explorer', shortcut: 'Ctrl+Shift+E', action: 'toggle-explorer' },
      { label: 'AI Asistan', shortcut: 'Ctrl+Shift+A', action: 'toggle-ai' },
      { label: 'Terminal', shortcut: 'Ctrl+`', action: 'toggle-terminal' },
      { divider: true },
      { label: 'Kelime Kaydırma', shortcut: 'Alt+Z', action: 'toggle-word-wrap' },
      { divider: true },
      { label: 'Tam Ekran', shortcut: 'F11', action: 'fullscreen' },
      { label: 'Yakınlaştır', shortcut: 'Ctrl+=', action: 'zoom-in' },
      { label: 'Uzaklaştır', shortcut: 'Ctrl+-', action: 'zoom-out' },
      { label: 'Sıfırla', shortcut: 'Ctrl+0', action: 'zoom-reset' },
    ],
    Go: [
      { label: 'Satıra Git...', shortcut: 'Ctrl+G', action: 'go-to-line' },
      { label: 'Sembole Git...', shortcut: 'Ctrl+Shift+O', action: 'go-to-symbol' },
      { label: 'Tanıma Git', shortcut: 'F12', action: 'go-to-definition' },
    ],
    Terminal: [
      { label: 'Yeni Terminal', shortcut: 'Ctrl+Shift+`', action: 'new-terminal' },
      { label: 'Terminal Aç/Kapat', shortcut: 'Ctrl+`', action: 'toggle-terminal' },
      { divider: true },
      { label: 'Terminali Temizle', shortcut: 'Ctrl+K', action: 'clear-terminal' },
    ],
    Help: [
      { label: 'Klavye Kısayolları Göster', shortcut: 'Ctrl+K Ctrl+S', action: 'show-shortcuts' },
      { divider: true },
      { label: 'Hakkında', action: 'about' },
    ],
  };

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (navbarRef.current && !navbarRef.current.contains(event.target)) {
        setActiveMenu(null);
      }
    };
    if (activeMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [activeMenu]);

  useEffect(() => {
    const onFSChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFSChange);
    return () => document.removeEventListener('fullscreenchange', onFSChange);
  }, []);

  // Klavye kısayolları (Ctrl+K ile sadece navbar açık menüde çalışır, geri kalanlar Monaco/Tarayıcı ile)
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') setActiveMenu(null);
      if (e.key === 'F11') { e.preventDefault(); onViewAction?.('fullscreen'); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onViewAction]);

  const handleMenuClick = (menuName) => {
    setActiveMenu(prev => (prev === menuName ? null : menuName));
  };

  const handleMenuItemClick = (item) => {
    if (!item.action) { setActiveMenu(null); return; }

    const fileActions = ['open-folder', 'open-file', 'save-file', 'save-as', 'new-file'];
    if (fileActions.includes(item.action)) {
      onFileAction?.(item.action);
    } else if (item.action === 'show-shortcuts') {
      window.open('https://code.visualstudio.com/shortcuts/keyboard-shortcuts-windows.pdf', '_blank');
    } else if (item.action === 'about') {
      alert('StackMate Web IDE\nVersiyon 1.0.0\n\nMicrosoft VS Code ile ilham alınmıştır.');
    } else {
      onViewAction?.(item.action);
    }
    setActiveMenu(null);
  };

  return (
    <div className="navbar" ref={navbarRef}>

      {/* ── Sol: Logo + Menüler ── */}
      <div className="navbar-left">
        <div className="navbar-logo" title="StackMate Web IDE">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="1" width="6" height="6" rx="1" fill="#007acc" />
            <rect x="9" y="1" width="6" height="6" rx="1" fill="#007acc" opacity="0.7" />
            <rect x="1" y="9" width="6" height="6" rx="1" fill="#007acc" opacity="0.7" />
            <rect x="9" y="9" width="6" height="6" rx="1" fill="#007acc" opacity="0.5" />
          </svg>
        </div>

        <div className="navbar-menu">
          {Object.keys(menuItems).map((menuName) => (
            <div
              key={menuName}
              className="navbar-item"
              onMouseEnter={() => activeMenu && setActiveMenu(menuName)}
            >
              <div
                className={`navbar-label ${activeMenu === menuName ? 'active' : ''}`}
                onClick={() => handleMenuClick(menuName)}
              >
                {menuName}
              </div>
              {activeMenu === menuName && (
                <div className="navbar-dropdown">
                  {menuItems[menuName].map((item, i) =>
                    item.divider ? (
                      <div key={i} className="dropdown-divider" />
                    ) : (
                      <div
                        key={i}
                        className={`dropdown-item ${item.action ? 'clickable' : 'disabled'}`}
                        onClick={() => handleMenuItemClick(item)}
                      >
                        <span className="dropdown-label">{item.label}</span>
                        {item.shortcut && (
                          <span className="dropdown-shortcut">{item.shortcut}</span>
                        )}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Orta: Arama ── */}
      <div className="navbar-center">
        <div
          className="navbar-search"
          onClick={() => onFileAction?.('open-file')}
          title="Dosya Aç (Ctrl+O)"
        >
          <Search size={13} />
          <span className="navbar-search-text">
            {projectName ? projectName : 'Dosya aç veya klasör seç...'}
          </span>
          <span className="navbar-search-shortcut">Ctrl+O</span>
        </div>
      </div>

      {/* ── Sağ: Araç Butonları ── */}
      <div className="navbar-right">
        {/* Explorer toggle */}
        <button
          className={`navbar-action-btn ${showExplorer ? 'active' : ''}`}
          onClick={() => onViewAction?.('toggle-explorer')}
          title="Explorer'ı Göster/Gizle (Ctrl+Shift+E)"
        >
          <LayoutPanelLeft size={16} />
        </button>

        {/* Terminal toggle */}
        <button
          className={`navbar-action-btn ${showTerminal ? 'active' : ''}`}
          onClick={() => onViewAction?.('toggle-terminal')}
          title="Terminal'i Göster/Gizle (Ctrl+`)"
        >
          <PanelBottom size={16} />
        </button>

        <div className="navbar-separator" />



        {/* AI Asistan */}
        <button
          className={`navbar-action-btn ai-btn ${showAI ? 'active' : ''}`}
          onClick={() => onViewAction?.('toggle-ai')}
          title="AI Asistan (Ctrl+Shift+A)"
        >
          <Bot size={16} />
        </button>

        {/* Ayarlar */}
        <button
          className="navbar-action-btn"
          onClick={() => {
            alert('Ayarlar yakında eklenecek.\n\nMevcut kısayollar:\n• Ctrl+S — Kaydet\n• Ctrl+O — Dosya Aç\n• Ctrl+K Ctrl+O — Klasör Aç\n• Ctrl+F — Bul\n• Ctrl+H — Değiştir\n• Ctrl+` — Terminal\n• F11 — Tam Ekran');
          }}
          title="Ayarlar"
        >
          <Settings size={16} />
        </button>

        <div className="navbar-separator" />

        {/* Tam Ekran */}
        <button
          className="navbar-action-btn"
          onClick={() => onViewAction?.('fullscreen')}
          title={isFullscreen ? 'Tam Ekrandan Çık (F11)' : 'Tam Ekran (F11)'}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </div>
  );
};

export default Navbar;
