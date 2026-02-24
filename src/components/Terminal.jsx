import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import './Terminal.css';
import { X } from 'lucide-react';

const Terminal = ({ onClose, workingDirectory }) => {
  const containerRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const wsRef = useRef(null);
  const mountedRef = useRef(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Çift mount önleme
    if (mountedRef.current) return;
    mountedRef.current = true;

    // XTerm instance
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      convertEol: true,
      theme: {
        background: '#1e1e1e', foreground: '#cccccc', cursor: '#ffffff',
        black: '#000000', red: '#cd3131', green: '#0dbc79',
        yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc',
        cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666',
        brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
        brightBlue: '#3b8eea', brightMagenta: '#d670d6',
        brightCyan: '#29b8db', brightWhite: '#e5e5e5',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // DOM'a bağla
    term.open(containerRef.current);

    // fit() için güvenli çağrı - DOM tam hazır olana kadar bekle
    const safeFit = () => {
      try {
        const el = containerRef.current;
        if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
          fitAddon.fit();
          return true;
        }
      } catch (e) { /* sessizce geç */ }
      return false;
    };

    // İlk fit - birkaç kez dene
    let attempts = 0;
    const tryFit = () => {
      if (safeFit()) {
        term.focus();
        return;
      }
      if (++attempts < 10) {
        setTimeout(tryFit, 100);
      }
    };
    setTimeout(tryFit, 50);

    // WebSocket bağlantısı
    const ws = new WebSocket('ws://localhost:3001');
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (workingDirectory) {
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'chdir', directory: workingDirectory }));
          }
        }, 400);
      }
    };

    ws.onmessage = (e) => {
      try { term.write(e.data); } catch (_) {}
    };

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m✗ Backend bağlantısı kurulamadı\x1b[0m');
      term.writeln('\x1b[33m  node terminal-server.cjs çalıştırın\x1b[0m\r\n');
    };

    ws.onclose = () => {
      setConnected(false);
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    // Dışarıdan terminal temizleme isteği
    const onClearRequest = () => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('clear\r');
        } else {
          term.clear();
        }
      } catch (_) { }
    };
    window.addEventListener('terminal-clear', onClearRequest);

    // Pencere boyutu değişince
    const onResize = () => {
      if (!safeFit()) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener('resize', onResize);

    // ResizeObserver - panel boyutu değişince
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => safeFit());
      if (containerRef.current) ro.observe(containerRef.current);
    }

    return () => {
      mountedRef.current = false;
      window.removeEventListener('terminal-clear', onClearRequest);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      try { ws.close(); } catch (_) {}
      try { term.dispose(); } catch (_) {}
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="terminal-container">
      <div className="terminal-header">
        <span className="terminal-title">
          Terminal
          <span className={`terminal-status ${connected ? 'online' : 'offline'}`} />
        </span>
        <button className="terminal-close" onClick={onClose} title="Kapat">
          <X size={14} />
        </button>
      </div>
      <div
        ref={containerRef}
        className="terminal-content"
        onClick={() => xtermRef.current?.focus()}
      />
    </div>
  );
};

export default Terminal;
