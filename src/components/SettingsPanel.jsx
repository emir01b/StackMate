import React, { useEffect, useState } from 'react';
import { X, Save, PlugZap, Cpu, Code2, Palette, Info, Eye, EyeOff, Check, AlertCircle } from 'lucide-react';
import './SettingsPanel.css';

const sections = [
  { id: 'connection', label: 'AI bağlantısı', icon: PlugZap },
  { id: 'agent', label: 'Agent', icon: Cpu },
  { id: 'editor', label: 'Editör', icon: Code2 },
  { id: 'appearance', label: 'Görünüm', icon: Palette },
  { id: 'about', label: 'Hakkında', icon: Info },
];

const Field = ({ label, hint, children }) => (
  <label className="settings-field">
    <span className="settings-field-label">{label}</span>
    {children}
    {hint && <span className="settings-field-hint">{hint}</span>}
  </label>
);

const Switch = ({ label, hint, checked, onChange }) => (
  <label className="settings-switch-row">
    <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
    <span className="settings-switch-track" aria-hidden="true" />
  </label>
);

const SettingsPanel = ({ settings, onSave, onClose }) => {
  const [section, setSection] = useState('connection');
  const [draft, setDraft] = useState(settings);
  const [keyDraft, setKeyDraft] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [models, setModels] = useState([]);

  useEffect(() => { if (settings) setDraft(previous => previous || settings); }, [settings]);
  useEffect(() => {
    const closeOnEscape = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const update = (group, key, value) => setDraft(previous => ({ ...previous, [group]: { ...previous[group], [key]: value } }));
  const save = async (testAfter = false) => {
    if (!draft) return;
    setBusy(true);
    setNotice(null);
    try {
      const payload = {
        ai: { ...draft.ai }, editor: { ...draft.editor }, appearance: { ...draft.appearance },
      };
      delete payload.ai.apiKeySet;
      if (clearKey) payload.ai.apiKey = '';
      else if (keyDraft.trim()) payload.ai.apiKey = keyDraft.trim();
      const saved = await onSave(payload);
      setDraft(saved);
      setKeyDraft('');
      setClearKey(false);
      if (testAfter) {
        const response = await fetch('http://localhost:3001/api/settings/test');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Bağlantı kurulamadı');
        setModels(data.models || []);
        setNotice({ type: 'success', text: `${data.models?.length || 0} model bulundu. Bağlantı çalışıyor.` });
      } else {
        setNotice({ type: 'success', text: 'Ayarlar kaydedildi.' });
      }
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" role="presentation">
      <div className="settings-page" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <aside className="settings-sidebar">
          <div className="settings-sidebar-heading">STACKMATE</div>
          <div className="settings-sidebar-title">Ayarlar</div>
          <nav aria-label="Ayar bölümleri">
            {sections.map(item => <button key={item.id} className={section === item.id ? 'selected' : ''} onClick={() => { setSection(item.id); setNotice(null); }}>
              <item.icon size={15} /> {item.label}
            </button>)}
          </nav>
          <div className="settings-sidebar-footer">Tercihler bu cihazda saklanır.</div>
        </aside>
        <div className="settings-main">
          <header className="settings-topbar">
            <div><span>Ayarlar</span><h1 id="settings-title">{sections.find(item => item.id === section)?.label}</h1></div>
            <button className="settings-icon-button" onClick={onClose} title="Ayarları kapat" aria-label="Ayarları kapat"><X size={17} /></button>
          </header>

          {!draft ? <div className="settings-loading">Backend ayarları yükleniyor...</div> : <div className="settings-scroll">
            {section === 'connection' && <>
              <div className="settings-intro">OpenAI uyumlu bir yerel sunucu veya uzak API seçin. API anahtarı tarayıcıya geri gönderilmez.</div>
              <div className="settings-card">
                <div className="settings-card-title">Sağlayıcı</div>
                <div className="settings-segmented" role="group" aria-label="AI sağlayıcısı">
                  <button className={draft.ai.provider === 'local' ? 'active' : ''} onClick={() => update('ai', 'provider', 'local')}>Yerel</button>
                  <button className={draft.ai.provider === 'remote' ? 'active' : ''} onClick={() => update('ai', 'provider', 'remote')}>Uzak API</button>
                </div>
                {draft.ai.provider === 'local' ? <Field label="LM Studio / yerel API adresi" hint="Örnek: http://127.0.0.1:1234/v1">
                  <input value={draft.ai.localBaseUrl} onChange={event => update('ai', 'localBaseUrl', event.target.value)} spellCheck="false" />
                </Field> : <>
                  <Field label="API taban adresi" hint="OpenAI uyumlu /v1 adresi; uzak sunucuda HTTPS kullanılır.">
                    <input value={draft.ai.remoteBaseUrl} onChange={event => update('ai', 'remoteBaseUrl', event.target.value)} placeholder="https://api.example.com/v1" spellCheck="false" />
                  </Field>
                  <Field label="API anahtarı" hint={draft.ai.apiKeySet && !clearKey ? 'Kayıtlı anahtar var. Değiştirmek için yenisini girin.' : 'Anahtar cihazdaki backend ayar dosyasında düz metin saklanır.'}>
                    <div className="settings-key-row"><input type={showKey ? 'text' : 'password'} value={keyDraft} onChange={event => { setKeyDraft(event.target.value); setClearKey(false); }} placeholder={draft.ai.apiKeySet && !clearKey ? '••••••••  (değişmedi)' : 'sk-...'} autoComplete="off" />
                      <button type="button" onClick={() => setShowKey(value => !value)} title={showKey ? 'Gizle' : 'Göster'}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
                  </Field>
                  {draft.ai.apiKeySet && <button className="settings-text-button" onClick={() => { setClearKey(true); setKeyDraft(''); }}>Kayıtlı anahtarı sil</button>}
                  {clearKey && <p className="settings-hint-warning">Kaydettiğinizde mevcut anahtar silinecek.</p>}
                </>}
              </div>
              <div className="settings-card">
                <div className="settings-card-title">Model</div>
                <Field label="Model kimliği" hint="Model listesini alamayan servislerde kimliği elle girebilirsiniz.">
                  <input value={draft.ai.model} onChange={event => update('ai', 'model', event.target.value)} placeholder="Model adı / ID" spellCheck="false" />
                </Field>
                {models.length > 0 && <div className="settings-model-list" aria-label="Bulunan modeller">{models.map(model => <button key={model} className={draft.ai.model === model ? 'active' : ''} onClick={() => update('ai', 'model', model)}>{model}</button>)}</div>}
                <button className="settings-secondary-button" disabled={busy} onClick={() => save(true)}><PlugZap size={14} /> Kaydet ve bağlantıyı dene</button>
              </div>
            </>}

            {section === 'agent' && <>
              <div className="settings-intro">Agent’ın yanıt uzunluğunu ve dosya işlemlerinden sonra çalışma biçimini ayarlayın.</div>
              <div className="settings-card">
                <Field label={`Sıcaklık: ${draft.ai.temperature.toFixed(1)}`} hint="Düşük değerler kod düzenlemelerinde daha tutarlı yanıt verir.">
                  <input type="range" min="0" max="2" step="0.1" value={draft.ai.temperature} onChange={event => update('ai', 'temperature', Number(event.target.value))} />
                </Field>
                <Field label="En fazla çıktı tokenı"><input type="number" min="256" max="32768" value={draft.ai.maxTokens} onChange={event => update('ai', 'maxTokens', Number(event.target.value))} /></Field>
                <Switch label="Dosya işleminden sonra devam et" hint="Oluşturma, düzenleme ve okuma sonucundan sonra agent sıradaki adıma geçer." checked={draft.ai.autoContinue} onChange={value => update('ai', 'autoContinue', value)} />
                <Switch label="Yerel araç çağrıları" hint="Sağlayıcı araç çağrılarını desteklemiyorsa kapatın; agent metin etiketlerini kullanır." checked={draft.ai.useNativeTools !== false} onChange={value => update('ai', 'useNativeTools', value)} />
                <Field label="Otomatik adım sınırı" hint="Kontrolsüz döngüyü önlemek için tek istekteki üst sınır."><input type="number" min="1" max="100" value={draft.ai.maxAutoSteps} onChange={event => update('ai', 'maxAutoSteps', Number(event.target.value))} /></Field>
              </div>
            </>}

            {section === 'editor' && <>
              <div className="settings-intro">Bu tercihler açık editöre hemen uygulanır.</div>
              <div className="settings-card">
                <Field label="Yazı boyutu"><input type="number" min="10" max="28" value={draft.editor.fontSize} onChange={event => update('editor', 'fontSize', Number(event.target.value))} /></Field>
                <Field label="Girinti genişliği"><input type="number" min="1" max="8" value={draft.editor.tabSize} onChange={event => update('editor', 'tabSize', Number(event.target.value))} /></Field>
                <Switch label="Satırları kaydır" checked={draft.editor.wordWrap} onChange={value => update('editor', 'wordWrap', value)} />
                <Switch label="Minimap" checked={draft.editor.minimap} onChange={value => update('editor', 'minimap', value)} />
                <Switch label="Otomatik kaydet" checked={draft.editor.autoSave} onChange={value => update('editor', 'autoSave', value)} />
                {draft.editor.autoSave && <Field label="Kaydetme gecikmesi (ms)"><input type="number" min="300" max="10000" value={draft.editor.autoSaveDelay} onChange={event => update('editor', 'autoSaveDelay', Number(event.target.value))} /></Field>}
              </div>
            </>}

            {section === 'appearance' && <>
              <div className="settings-intro">Pencere yoğunluğunu ve vurgu rengini seçin.</div>
              <div className="settings-card">
                <div className="settings-card-title">Yoğunluk</div>
                <div className="settings-segmented"><button className={draft.appearance.density === 'comfortable' ? 'active' : ''} onClick={() => update('appearance', 'density', 'comfortable')}>Rahat</button><button className={draft.appearance.density === 'compact' ? 'active' : ''} onClick={() => update('appearance', 'density', 'compact')}>Kompakt</button></div>
                <div className="settings-card-title settings-spaced">Vurgu rengi</div>
                <div className="settings-accent-options">{[['blue', 'Mavi'], ['violet', 'Mor'], ['teal', 'Turkuaz']].map(([value, label]) => <button key={value} className={`accent-${value} ${draft.appearance.accent === value ? 'active' : ''}`} onClick={() => update('appearance', 'accent', value)}><span />{label}</button>)}</div>
              </div>
            </>}

            {section === 'about' && <div className="settings-card settings-about"><h2>StackMate</h2><p>Yerel projeler için AI destekli kod editörü.</p><p>Bağlantı ve arayüz tercihleri bu cihazda tutulur. API anahtarı tarayıcıya geri iletilmez; sunucu tarafından seçtiğiniz sağlayıcıya gönderilir.</p><div className="settings-shortcuts"><strong>Kısayollar</strong><span>Ctrl+S — Kaydet</span><span>Ctrl+O — Dosya aç</span><span>Ctrl+F — Bul</span><span>Ctrl+` — Terminal</span></div></div>}
          </div>}

          <footer className="settings-footer">
            {notice && <span className={`settings-notice ${notice.type}`}>{notice.type === 'success' ? <Check size={14} /> : <AlertCircle size={14} />}{notice.text}</span>}
            <button className="settings-secondary-button" onClick={onClose}>Kapat</button>
            <button className="settings-primary-button" onClick={() => save(false)} disabled={!draft || busy}><Save size={14} />{busy ? 'Kaydediliyor...' : 'Kaydet'}</button>
          </footer>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
