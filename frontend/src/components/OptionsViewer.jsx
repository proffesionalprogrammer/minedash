import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Save, Upload, Settings, List, Search, Image as ImageIcon, ChevronDown, Check, Cpu, RefreshCw, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ModalPortal from './ModalPortal';
import { useSystemRam } from '../hooks/useSystemRam';

// Minecraft properties that have fixed allowed values
const ENUM_PROPERTIES = {
  'difficulty': [
    { value: 'peaceful', label: 'Peaceful' },
    { value: 'easy', label: 'Easy' },
    { value: 'normal', label: 'Normal' },
    { value: 'hard', label: 'Hard' },
  ],
  'gamemode': [
    { value: 'survival', label: 'Survival' },
    { value: 'creative', label: 'Creative' },
    { value: 'adventure', label: 'Adventure' },
    { value: 'spectator', label: 'Spectator' },
  ],
  'level-type': [
    { value: 'minecraft\\:normal', label: 'Normal' },
    { value: 'minecraft\\:flat', label: 'Flat' },
    { value: 'minecraft\\:large_biomes', label: 'Large Biomes' },
    { value: 'minecraft\\:amplified', label: 'Amplified' },
    { value: 'minecraft\\:single_biome_surface', label: 'Single Biome' },
  ],
};

// Custom dropdown component matching Modrinth style.
// The menu is rendered via createPortal so it isn't clipped by any ancestor
// overflow-hidden / overflow-y-auto container (the properties list scrolls,
// and the outer tab card is overflow-hidden for its rounded corners).
function CustomDropdown({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [coords, setCoords] = useState(null);

  const currentOption = options.find(o => o.value === value);
  const displayLabel = currentOption ? currentOption.label : value;

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const compute = () => {
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      // Anchor right edge so it matches the original right-0 alignment.
      setCoords({ top: r.bottom + 8, right: window.innerWidth - r.right, width: 192 });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 bg-[var(--c-base)] border border-[var(--c-border)] text-[var(--c-text-primary)] text-sm px-4 py-1.5 rounded-xl hover:border-[var(--c-text-muted)] focus:outline-none focus:border-[#00AF5C] transition-colors w-48 justify-between"
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown size={14} className={`text-[var(--c-text-muted)] transition-transform flex-shrink-0 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && coords && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: coords.top, right: coords.right, width: coords.width, zIndex: 9999 }}
          className="bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden py-1"
        >
          {options.map(opt => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-4 py-2.5 text-sm font-medium transition-colors flex items-center justify-between ${
                  isSelected
                    ? 'bg-[#00AF5C] text-white'
                    : 'text-[var(--c-text-primary)] hover:bg-[var(--c-border)]'
                }`}
              >
                <span>{opt.label}</span>
                {isSelected && <Check size={14} />}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

export default function OptionsViewer({ server, onError }) {
  const [activeTab, setActiveTab] = useState('general');

  return (
    <div className="flex h-full gap-6">
      <div className="w-48 flex-shrink-0 flex flex-col gap-2">
        <SidebarBtn active={activeTab === 'general'} onClick={() => setActiveTab('general')} icon={<Settings size={18}/>} label="General" />
        <SidebarBtn active={activeTab === 'properties'} onClick={() => setActiveTab('properties')} icon={<List size={18}/>} label="Properties" />
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar pr-4 pb-12">
        {activeTab === 'general' && <GeneralSettings server={server} onError={onError} />}
        {activeTab === 'properties' && <PropertiesSettings server={server} onError={onError} />}
      </div>
    </div>
  );
}

function SidebarBtn({ active, onClick, icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 px-4 py-3 rounded-xl font-bold text-sm transition-all ${
        active 
          ? 'bg-[var(--c-surface-2)] text-[var(--c-text-primary)] border border-[var(--c-border)]' 
          : 'text-[var(--c-text-secondary)] hover:bg-[var(--c-surface-2)] hover:text-[var(--c-text-primary)] border border-transparent'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

const RAM_MIN = 1;
const RAM_MAX_FALLBACK = 32; // used until the system's real total RAM is fetched

function parseRamGB(val) {
  const n = parseInt(val);
  return isNaN(n) ? 2 : n;
}

function GeneralSettings({ server, onError }) {
  const [name, setName] = useState(server.name || '');
  const [loading, setLoading] = useState(false);
  const [iconPreview, setIconPreview] = useState(`http://localhost:3001/api/servers/${server.id}/icon.png`);
  const [ram, setRam] = useState(Math.max(parseRamGB(server.minRam), parseRamGB(server.maxRam)));
  const [elybySkins, setElybySkins] = useState(!!server.elybySkins);
  const [showRegenModal, setShowRegenModal] = useState(false);
  const [regenSeed, setRegenSeed] = useState('');
  const [regenLoading, setRegenLoading] = useState(false);

  const ramMax = useSystemRam(RAM_MAX_FALLBACK);
  const handleRamChange = (val) => setRam(parseInt(val));
  const ramPercent = ((ram - RAM_MIN) / (ramMax - RAM_MIN)) * 100;

  const handleSave = async () => {
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${server.id}/general`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, minRam: ram + 'G', maxRam: ram + 'G', elybySkins })
      });
      if (!res.ok) throw new Error('Failed to save settings');
    } catch (e) {
      if (onError) onError(e.message);
    }
    setLoading(false);
  };

  const handleIconUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('icon', file);
    
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${server.id}/icon`, {
        method: 'POST',
        body: formData
      });
      if (!res.ok) throw new Error('Failed to upload icon');
      setIconPreview(URL.createObjectURL(file));
    } catch (err) {
      if (onError) onError(err.message);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl p-6">
        <h3 className="text-lg font-bold text-[var(--c-text-primary)] mb-1">Server name</h3>
        <p className="text-sm text-[var(--c-text-secondary)] mb-4">Change the name of your server. This name is only visible on your dashboard.</p>
        <input 
          type="text" 
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-[var(--c-base)] border border-[var(--c-border)] rounded-xl px-4 py-3 text-[var(--c-text-primary)] focus:outline-none focus:border-[#00AF5C] transition-colors"
        />
      </div>

      <div className="bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl p-6">
        <h3 className="text-lg font-bold text-[var(--c-text-primary)] mb-1">Server icon</h3>
        <p className="text-sm text-[var(--c-text-secondary)] mb-4">Change your server's icon. Changes will be visible on the Minecraft server list.</p>
        <div className="flex items-center gap-6">
          <div className="w-20 h-20 bg-[var(--c-base)] border border-[var(--c-border)] rounded-xl overflow-hidden flex items-center justify-center">
            {iconPreview ? (
              <img src={iconPreview} alt="Server Icon" className="w-full h-full object-cover" onError={(e) => e.target.style.display='none'} />
            ) : (
              <ImageIcon className="text-[var(--c-text-muted)]" size={32} />
            )}
          </div>
          <div>
            <label className="cursor-pointer bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] text-[var(--c-text-primary)] px-4 py-2.5 rounded-xl text-sm font-bold transition-all inline-flex items-center gap-2">
              <Upload size={16} />
              Upload Image
              <input type="file" accept="image/png" className="hidden" onChange={handleIconUpload} />
            </label>
            <p className="text-xs text-[var(--c-text-muted)] mt-2">Must be a 64x64 PNG image.</p>
          </div>
        </div>
      </div>

      <div className="bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl p-6">
        <h3 className="text-lg font-bold text-[var(--c-text-primary)] mb-1">Memory (RAM)</h3>
        <p className="text-sm text-[var(--c-text-secondary)] mb-5">Adjust JVM heap size. Changes take effect on the next server start.</p>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-bold text-[var(--c-text-primary)] flex items-center gap-2">
              <Cpu size={15} className="text-[var(--c-text-secondary)]" />
              Memory
            </label>
            <span className="text-sm font-bold text-[#00AF5C] bg-[#00AF5C]/10 px-3 py-1 rounded-lg tabular-nums">{ram} GB</span>
          </div>
          <input
            type="range"
            min={RAM_MIN}
            max={ramMax}
            step={1}
            value={ram}
            onChange={(e) => handleRamChange(e.target.value)}
            style={{ '--fill': `${ramPercent}%` }}
            className="w-full ram-slider"
          />
          <div className="flex justify-between text-xs text-[var(--c-text-muted)]">
            <span>{RAM_MIN} GB</span><span>{ramMax} GB</span>
          </div>
        </div>
      </div>

      <div className="bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl p-6">
        <h3 className="text-lg font-bold text-[var(--c-text-primary)] mb-1">Ely.by skins for players</h3>
        <p className="text-sm text-[var(--c-text-secondary)] mb-4">
          Lets offline players show the skin from their free Ely.by account to everyone on this
          server (no Ely.by login needed). Players just need a matching Ely.by username with a skin
          uploaded.
        </p>
        <label className="flex items-start gap-3 cursor-pointer">
          <span className="custom-checkbox-wrapper mt-0.5">
            <input type="checkbox" className="custom-checkbox" checked={elybySkins}
              onChange={(e) => setElybySkins(e.target.checked)} />
            <span className="custom-checkbox-visual" />
          </span>
          <span>
            <span className="text-sm font-bold text-[var(--c-text-primary)]">Enable Ely.by skins on this server</span>
            <span className="block text-xs text-[var(--c-text-secondary)] mt-0.5 leading-snug">
              Applied on the next start. <span className="text-amber-400 font-bold">Set <code className="font-mono">online-mode=false</code> in Server properties</span> — with online mode on, this forces Ely.by authentication and premium players can't join.
            </span>
          </span>
        </label>
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={loading}
          className="bg-[#00AF5C] hover:bg-[#00964F] text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 transition-colors disabled:opacity-50"
        >
          <Save size={18} />
          Save Changes
        </button>
      </div>

      {/* Danger Zone */}
      <div className="bg-[var(--c-surface-2)] border border-[var(--c-danger)]/30 rounded-2xl p-6">
        <h3 className="text-lg font-bold text-[var(--c-danger)] mb-1">Danger zone</h3>
        <p className="text-sm text-[var(--c-text-secondary)] mb-4">These actions are irreversible. Be careful.</p>
        <div className="flex items-center justify-between p-4 bg-[var(--c-base)] rounded-xl border border-[var(--c-border)]">
          <div>
            <p className="font-bold text-[var(--c-text-primary)] text-sm">Regenerate world</p>
            <p className="text-xs text-[var(--c-text-secondary)] mt-0.5">Delete the current world and start fresh on a new seed. The server must be stopped.</p>
          </div>
          <button
            onClick={() => {
              if (server.status === 'online') { if (onError) onError('Stop the server before regenerating the world.'); return; }
              setRegenSeed('');
              setShowRegenModal(true);
            }}
            className="flex-shrink-0 ml-4 flex items-center gap-2 px-4 py-2 bg-[var(--c-danger)]/10 hover:bg-[var(--c-danger)]/20 text-[var(--c-danger)] border border-[var(--c-danger)]/30 rounded-xl text-sm font-bold transition-all"
          >
            <RefreshCw size={15} />
            Regenerate
          </button>
        </div>
      </div>

      {/* Regenerate World Modal */}
      <AnimatePresence>
        {showRegenModal && (
          <ModalPortal>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-[#000000]/80 z-[100] flex items-center justify-center backdrop-blur-sm"
            onClick={() => !regenLoading && setShowRegenModal(false)}>
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
              className="bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-3xl w-full max-w-md mx-4 shadow-2xl"
              onClick={e => e.stopPropagation()}>
              <div className="p-8">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-[var(--c-danger)]/10 flex items-center justify-center flex-shrink-0">
                    <AlertTriangle size={20} className="text-[var(--c-danger)]" />
                  </div>
                  <h3 className="text-xl font-bold text-[var(--c-text-primary)]">Regenerate world?</h3>
                </div>
                <p className="text-sm text-[var(--c-text-secondary)] leading-relaxed mb-6">
                  This will permanently delete <span className="text-[var(--c-text-primary)] font-bold">all world data</span> — terrain, builds, player inventories, and progress. This cannot be undone.
                </p>

                <div className="mb-6">
                  <label className="block text-sm font-bold text-[var(--c-text-primary)] mb-2">New seed <span className="text-[var(--c-text-muted)] font-medium">(leave blank for random)</span></label>
                  <input
                    type="text"
                    value={regenSeed}
                    onChange={e => setRegenSeed(e.target.value)}
                    placeholder="e.g. 8675309 or leave blank"
                    className="w-full bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[var(--c-danger)] rounded-xl px-4 py-3 text-[var(--c-text-primary)] text-sm outline-none transition-colors placeholder-[var(--c-text-muted)] focus:ring-4 focus:ring-[var(--c-danger)]/10"
                  />
                </div>

                <div className="flex gap-3 pt-4 border-t border-[var(--c-border)]">
                  <button
                    onClick={() => setShowRegenModal(false)}
                    disabled={regenLoading}
                    className="flex-1 px-4 py-2.5 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] text-[var(--c-text-primary)] rounded-xl text-sm font-bold transition-all disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      setRegenLoading(true);
                      try {
                        const res = await fetch(`http://localhost:3001/api/servers/${server.id}/regenerate-world`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ seed: regenSeed.trim() }),
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Failed to regenerate world');
                        setShowRegenModal(false);
                      } catch (err) {
                        if (onError) onError(err.message);
                        setShowRegenModal(false);
                      }
                      setRegenLoading(false);
                    }}
                    disabled={regenLoading}
                    className="flex-1 px-4 py-2.5 bg-[var(--c-danger)] hover:bg-[var(--c-danger-hover)] text-white rounded-xl text-sm font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    <RefreshCw size={15} className={regenLoading ? 'animate-spin' : ''} />
                    {regenLoading ? 'Regenerating...' : 'Delete & Regenerate'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
          </ModalPortal>
        )}
      </AnimatePresence>
    </div>
  );
}

function PropertiesSettings({ server, onError }) {
  const [properties, setProperties] = useState({});
  const [originalProperties, setOriginalProperties] = useState({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    fetch(`http://localhost:3001/api/servers/${server.id}/properties`)
      .then(res => res.json())
      .then(data => {
        setProperties(data);
        setOriginalProperties(data);
        setLoading(false);
      })
      .catch(err => {
        if (onErrorRef.current) onErrorRef.current(err.message);
        setLoading(false);
      });
  }, [server.id]);

  const updateProperty = (key, value) => {
    setProperties(prev => ({ ...prev, [key]: value }));
  };

  const hasChanges = JSON.stringify(properties) !== JSON.stringify(originalProperties);

  const handleSave = async (restart = false) => {
    setSaving(true);
    try {
      const res = await fetch(`http://localhost:3001/api/servers/${server.id}/properties`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(properties)
      });
      if (!res.ok) throw new Error('Failed to save properties');
      
      setOriginalProperties(properties);
      
      if (restart) {
        await fetch(`http://localhost:3001/api/servers/${server.id}/restart`, { method: 'POST' });
        setToastMessage("Properties saved and server restarted.");
      } else {
        setToastMessage("Server properties updated. Your server properties were successfully changed.");
      }
      setTimeout(() => setToastMessage(null), 4000);
    } catch (e) {
      if (onErrorRef.current) onErrorRef.current(e.message);
    }
    setSaving(false);
  };

  if (loading) return <div className="text-[var(--c-text-secondary)] p-6">Loading properties...</div>;

  const entries = Object.entries(properties).filter(([k]) => k.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="relative h-full flex flex-col">
      <div className="bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl overflow-hidden flex flex-col mb-16 flex-1 min-h-0">
        <div className="p-6 border-b border-[var(--c-border)] flex-shrink-0">
          <h3 className="text-lg font-bold text-[var(--c-text-primary)] mb-1">Server properties</h3>
          <p className="text-sm text-[var(--c-text-secondary)] mb-6">Edit the Minecraft server.properties file.</p>
          
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--c-text-muted)]" size={18} />
            <input 
              type="text" 
              placeholder="Search server properties..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-[var(--c-base)] border border-[var(--c-border)] rounded-xl pl-11 pr-4 py-3 text-[var(--c-text-primary)] outline-none focus:border-[#00AF5C] focus:ring-4 focus:ring-[#00AF5C]/10 transition-all placeholder-[var(--c-text-muted)] text-sm"
            />
          </div>
        </div>

        <div className="p-2 flex flex-col gap-1 overflow-y-auto custom-scrollbar">
          {entries.map(([key, value]) => {
            const isBoolean = value === 'true' || value === 'false';
            const enumOptions = ENUM_PROPERTIES[key];
            const niceName = key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            
            return (
              <div key={key} className="flex items-center justify-between p-4 hover:bg-[var(--c-border)]/30 rounded-xl transition-colors group">
                <span className="text-[var(--c-text-primary)] text-sm font-medium">{niceName}</span>
                {enumOptions && !isBoolean ? (
                  <CustomDropdown
                    value={value}
                    options={enumOptions}
                    onChange={(v) => updateProperty(key, v)}
                  />
                ) : isBoolean ? (
                  <button 
                    onClick={() => updateProperty(key, value === 'true' ? 'false' : 'true')}
                    className={`w-11 h-6 rounded-full relative transition-colors ${value === 'true' ? 'bg-[#00AF5C]' : 'bg-[var(--c-text-muted)]'}`}
                  >
                    <div className={`absolute top-1 bottom-1 w-4 bg-white rounded-full transition-all ${value === 'true' ? 'left-6' : 'left-1'}`}></div>
                  </button>
                ) : (
                  <input 
                    type="text" 
                    value={value}
                    onChange={(e) => updateProperty(key, e.target.value)}
                    className="bg-[var(--c-base)] border border-[var(--c-border)] text-[var(--c-text-primary)] text-sm px-3 py-1.5 rounded-lg focus:outline-none focus:border-[#00AF5C] text-right w-48"
                  />
                )}
              </div>
            );
          })}
          {entries.length === 0 && (
            <div className="p-6 text-center text-[var(--c-text-secondary)] text-sm">No properties found matching "{search}"</div>
          )}
        </div>
      </div>

      {hasChanges && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[90%] max-w-2xl bg-[#FFFFFF] rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.5)] p-4 flex items-center justify-between z-20 animate-in slide-in-from-bottom-10">
          <span className="text-[#111111] font-bold text-sm ml-2">Careful, you have unsaved changes!</span>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setProperties(originalProperties)}
              className="px-4 py-2 text-[var(--c-text-muted)] hover:text-[#111111] text-sm font-bold transition-colors"
            >
              Reset
            </button>
            <button 
              onClick={() => handleSave(false)}
              disabled={saving}
              className="px-4 py-2 border border-[#E0E0E0] hover:bg-[#F5F5F5] text-[#111111] rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
            >
              Save
            </button>
            <button 
              onClick={() => handleSave(true)}
              disabled={saving}
              className="px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
            >
              Save & restart
            </button>
          </div>
        </div>
      )}

      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-[#00AF5C] text-white p-4 rounded-xl shadow-lg max-w-sm animate-in slide-in-from-right-10">
          <h4 className="font-bold mb-1">{toastMessage.split('.')[0]}</h4>
          <p className="text-sm opacity-90">{toastMessage.split('.').slice(1).join('.').trim()}</p>
        </div>
      )}
    </div>
  );
}
