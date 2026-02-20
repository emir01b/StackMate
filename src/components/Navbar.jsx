import React, { useState, useEffect, useRef } from 'react';
import './Navbar.css';

const Navbar = ({ onFileAction, onViewAction }) => {
  const [activeMenu, setActiveMenu] = useState(null);
  const navbarRef = useRef(null);

  const menuItems = {
    File: [
      { label: 'Yeni Dosya', shortcut: 'Ctrl+N', action: 'new-file' },
      { label: 'Klasör Aç...', shortcut: 'Ctrl+K Ctrl+O', action: 'open-folder' },
      { label: 'Dosya Aç...', shortcut: 'Ctrl+O', action: 'open-file' },
      { divider: true },
      { label: 'Kaydet', shortcut: 'Ctrl+S', action: 'save-file' },
      { label: 'Farklı Kaydet...', shortcut: 'Ctrl+Shift+S', action: 'save-as' },
      { divider: true },
      { label: 'Tercihleri', shortcut: 'Ctrl+,' },
      { label: 'Çıkış', shortcut: 'Ctrl+Q' }
    ],
    Edit: [
      { label: 'Geri Al', shortcut: 'Ctrl+Z' },
      { label: 'Yinele', shortcut: 'Ctrl+Y' },
      { divider: true },
      { label: 'Kes', shortcut: 'Ctrl+X' },
      { label: 'Kopyala', shortcut: 'Ctrl+C' },
      { label: 'Yapıştır', shortcut: 'Ctrl+V' },
      { divider: true },
      { label: 'Bul', shortcut: 'Ctrl+F', action: 'find' },
      { label: 'Değiştir', shortcut: 'Ctrl+H', action: 'replace' }
    ],
    Selection: [
      { label: 'Tümünü Seç', shortcut: 'Ctrl+A' },
      { label: 'Satırı Genişlet', shortcut: 'Ctrl+L' },
      { divider: true },
      { label: 'Yukarı Kopyala', shortcut: 'Shift+Alt+↑' },
      { label: 'Aşağı Kopyala', shortcut: 'Shift+Alt+↓' },
      { divider: true },
      { label: 'Çoklu İmleç Ekle', shortcut: 'Ctrl+Alt+↓' }
    ],
    View: [
      { label: 'Komut Paleti', shortcut: 'Ctrl+Shift+P' },
      { divider: true },
      { label: 'Explorer', shortcut: 'Ctrl+Shift+E', action: 'toggle-explorer' },
      { label: 'Terminal', shortcut: 'Ctrl+`', action: 'toggle-terminal' },
      { label: 'AI Assistant', shortcut: 'Ctrl+Shift+A', action: 'toggle-ai' },
      { divider: true },
      { label: 'Tam Ekran', shortcut: 'F11', action: 'fullscreen' },
      { label: 'Yakınlaştır', shortcut: 'Ctrl+=' },
      { label: 'Uzaklaştır', shortcut: 'Ctrl+-' }
    ],
    Terminal: [
      { label: 'Yeni Terminal', shortcut: 'Ctrl+Shift+`', action: 'new-terminal' },
      { label: 'Terminal Aç/Kapat', shortcut: 'Ctrl+`', action: 'toggle-terminal' },
      { divider: true },
      { label: 'Terminal Temizle', shortcut: 'Ctrl+K' },
      { label: 'Terminal Böl', shortcut: 'Ctrl+Shift+5' }
    ]
  };

  // Dışarı tıklanınca menüyü kapat
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (navbarRef.current && !navbarRef.current.contains(event.target)) {
        setActiveMenu(null);
      }
    };

    if (activeMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [activeMenu]);

  const handleMenuClick = (menuName) => {
    setActiveMenu(activeMenu === menuName ? null : menuName);
  };

  const handleMenuItemClick = (item) => {
    if (item.action) {
      if (item.action.startsWith('open-') || item.action.startsWith('save-') || item.action === 'new-file') {
        onFileAction?.(item.action);
      } else {
        onViewAction?.(item.action);
      }
    }
    setActiveMenu(null);
  };

  return (
    <div className="navbar" ref={navbarRef}>
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
                {menuItems[menuName].map((item, index) => (
                  item.divider ? (
                    <div key={index} className="dropdown-divider" />
                  ) : (
                    <div
                      key={index}
                      className={`dropdown-item ${item.action ? 'clickable' : 'disabled'}`}
                      onClick={() => item.action && handleMenuItemClick(item)}
                    >
                      <span className="dropdown-label">{item.label}</span>
                      {item.shortcut && (
                        <span className="dropdown-shortcut">{item.shortcut}</span>
                      )}
                    </div>
                  )
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default Navbar;
