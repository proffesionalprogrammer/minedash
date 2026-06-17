import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Cpu, Check, Loader2, FolderOpen, FileDown, Trash2, Clock,
  Maximize2, Monitor, SquareTerminal, Terminal, Braces, Wrench,
} from 'lucide-react';
import { formatPlaytime, formatLastPlayed } from '../../lib/playtime';
import { useSystemRam } from '../../hooks/useSystemRam';
import {
  Field, ToggleChip, SecondaryButton, NumberInput, MonoInput, CheckRow, EnvVarsEditor, OverrideSection,
} from './controls';

const RAM_MIN = 1;
const RAM_MAX_FALLBACK = 16;

// The per-instance override sections (Prism-style). Each maps to a set of keys
// the backend accepts under `overrides`; a section is "on" when the instance
// stores any of its keys.
const OV_SECTIONS = [
  { key: 'window',   title: 'Game window',          icon: Maximize2,     keys: ['windowWidth', 'windowHeight', 'fullscreen'] },
  { key: 'behavior', title: 'Launcher behavior',    icon: Monitor,       keys: ['afterLaunch', 'quitOnGameClose'] },
  { key: 'console',  title: 'Console window',       icon: SquareTerminal,keys: ['consoleShowOnLaunch', 'consoleShowOnCrash', 'consoleHideOnExit'] },
  { key: 'commands', title: 'Custom commands',      icon: Terminal,      keys: ['preLaunchCommand', 'postExitCommand'] },
  { key: 'env',      title: 'Environment variables',icon: Braces,        keys: ['gameEnv'] },
  { key: 'tweaks',   title: 'Tweaks',               icon: Wrench,        keys: ['useSystemGlfw', 'glfwPath', 'useSystemOpenal', 'openalPath'] },
];

// Canonical JSON for shallow override comparison (top-level keys sorted).
function canon(ov) {
  const out = {};
  for (const k of Object.keys(ov).sort()) out[k] = ov[k];
  return JSON.stringify(out);
}

// Settings panel: display name + per-instance RAM + per-instance overrides of
// the global Minecraft settings + files (open folder / export) + delete.
export default function InstanceSettingsPanel({ inst, settings, patch, onError, onDeleted }) {
  const ramMax = useSystemRam(RAM_MAX_FALLBACK);
  const [name, setName] = useState(inst.displayName || '');
  const [savingName, setSavingName] = useState(false);

  const [custom, setCustom] = useState(typeof inst.ram === 'number' && inst.ram >= 1);
  const [ram, setRam] = useState(typeof inst.ram === 'number' && inst.ram >= 1 ? inst.ram : 4);
  const [savingRam, setSavingRam] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ── Override editing state ────────────────────────────────────────
  const g = settings || {};
  const overridesKey = JSON.stringify(inst.overrides || {});
  const [secOn, setSecOn] = useState({});
  const [draft, setDraft] = useState({});
  const [savingOv, setSavingOv] = useState(false);

  // (Re)seed the override draft whenever the instance's saved overrides change
  // (a save round-trips inst via onSaved) or the global defaults shift.
  useEffect(() => {
    const ov = inst.overrides || {};
    const nextSec = {};
    for (const s of OV_SECTIONS) nextSec[s.key] = s.keys.some(k => Object.prototype.hasOwnProperty.call(ov, k));
    const nextDraft = {};
    for (const s of OV_SECTIONS) for (const k of s.keys) {
      nextDraft[k] = ov[k] !== undefined ? ov[k] : g[k];
    }
    if (nextDraft.gameEnv == null) nextDraft.gameEnv = [];
    setSecOn(nextSec);
    setDraft(nextDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.id, overridesKey, JSON.stringify({ w: g.windowWidth, h: g.windowHeight })]);

  useEffect(() => { setName(inst.displayName || ''); }, [inst.displayName]);

  const nameDirty = name.trim() && name.trim() !== (inst.displayName || '');
  const savedRam = typeof inst.ram === 'number' && inst.ram >= 1 ? inst.ram : null;
  const ramDirty = custom ? ram !== savedRam : savedRam !== null;
  const ramPercent = ramMax > RAM_MIN ? ((ram - RAM_MIN) / (ramMax - RAM_MIN)) * 100 : 0;

  const setKey = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  // The override map this UI currently represents (only on-sections' keys).
  const effectiveOverrides = useMemo(() => {
    const e = {};
    for (const s of OV_SECTIONS) if (secOn[s.key]) for (const k of s.keys) e[k] = draft[k];
    return e;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secOn, draft]);
  const ovDirty = canon(effectiveOverrides) !== canon(inst.overrides || {});

  const saveName = async () => {
    if (!nameDirty) return;
    setSavingName(true);
    try { await patch({ displayName: name.trim() }); } catch (err) { onError?.(err.message); }
    setSavingName(false);
  };
  const saveRam = async () => {
    setSavingRam(true);
    try { await patch({ ram: custom ? ram : null }); } catch (err) { onError?.(err.message); }
    setSavingRam(false);
  };
  const saveOverrides = async () => {
    // Send every overridable key: a value for on-sections, null to clear off ones.
    const body = {};
    for (const s of OV_SECTIONS) for (const k of s.keys) body[k] = secOn[s.key] ? draft[k] : null;
    setSavingOv(true);
    try { await patch({ overrides: body }); } catch (err) { onError?.(err.message); }
    setSavingOv(false);
  };

  const handleOpenFolder = async () => {
    try { await fetch(`http://localhost:3001/api/launcher/instances/${inst.id}/open-folder`, { method: 'POST' }); }
    catch (err) { onError?.(err.message); }
  };
  const handleExport = async () => {
    setExporting(true);
    try {
      const url = `http://localhost:3001/api/launcher/instances/${encodeURIComponent(inst.id)}/export`;
      const r = await fetch(`${url}?check=1`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Export failed');
      const a = document.createElement('a');
      a.href = url; a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (err) { onError?.(err.message); }
    setExporting(false);
  };
  const handleDelete = async () => {
    setDeleting(true);
    try {
      const r = await fetch(`http://localhost:3001/api/launcher/instances/${inst.id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Failed to delete');
      onDeleted?.(inst.id);
    } catch (err) { onError?.(err.message); setDeleting(false); setConfirmDelete(false); }
  };

  const toggleSection = (key) => setSecOn(s => ({ ...s, [key]: !s[key] }));
  const showPlaytime = settings?.showPlaytime !== false;
  const lastPlayedLabel = formatLastPlayed(inst.lastPlayed);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-5 space-y-6">
      {/* Game time */}
      {showPlaytime && (inst.playtimeMs > 0 || lastPlayedLabel) && (
        <div className="flex items-center gap-4 px-4 py-3 bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl">
          <div className="p-2 bg-[#00AF5C]/10 rounded-xl"><Clock size={16} className="text-[#00AF5C]" /></div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-[var(--c-text-primary)] tabular-nums">
              {formatPlaytime(inst.playtimeMs, !!settings?.durationsInHours)} played
            </p>
            {lastPlayedLabel && <p className="text-[11px] text-[var(--c-text-secondary)]">Last played {lastPlayedLabel}</p>}
          </div>
        </div>
      )}

      {/* Display name */}
      <Field label="Display name">
        <div className="flex items-center gap-2">
          <input
            type="text" value={name} maxLength={60}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveName(); }}
            className="flex-1 min-w-0 bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] rounded-xl px-3 py-2.5 text-sm font-bold text-[var(--c-text-primary)] outline-none focus:ring-4 focus:ring-[#00AF5C]/10 transition-all"
          />
          <motion.button onClick={saveName} disabled={!nameDirty || savingName} whileTap={{ scale: 0.97 }}
            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-sm font-bold bg-[#00AF5C] hover:bg-[#00964F] text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {savingName ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save
          </motion.button>
        </div>
      </Field>

      {/* Memory */}
      <Field label="Memory" icon={Cpu}
        action={<ToggleChip on={custom} onLabel="Custom" offLabel="Global default" onToggle={() => setCustom(c => !c)} />}>
        {custom ? (
          <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--c-text-secondary)] font-bold">Allocate to this instance</span>
              <span className="text-sm font-bold text-[#00AF5C] bg-[#00AF5C]/10 px-3 py-1 rounded-lg tabular-nums">{ram} GB</span>
            </div>
            <input type="range" min={RAM_MIN} max={ramMax} step={1} value={ram}
              onChange={e => setRam(Number(e.target.value))}
              style={{ '--fill': `${ramPercent}%` }} className="w-full ram-slider" />
            <div className="flex justify-between text-xs text-[var(--c-text-muted)] px-0.5">
              <span>{RAM_MIN} GB</span><span>{ramMax} GB</span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-[var(--c-text-secondary)] pt-1">
            Uses the global memory amount from <span className="font-bold text-[var(--c-text-primary)]">Settings</span>. Turn on <span className="font-bold text-[var(--c-text-primary)]">Custom</span> to give this instance its own heap.
          </p>
        )}
        {ramDirty && (
          <div className="flex justify-end pt-1">
            <motion.button onClick={saveRam} disabled={savingRam} whileTap={{ scale: 0.97 }}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold bg-[#00AF5C] hover:bg-[#00964F] text-white transition-colors disabled:opacity-50">
              {savingRam ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save memory
            </motion.button>
          </div>
        )}
      </Field>

      {/* Per-instance overrides */}
      <Field label="Instance overrides">
        <p className="text-[11px] text-[var(--c-text-secondary)] -mt-1 mb-3">
          Each section follows the global <span className="font-bold text-[var(--c-text-primary)]">Settings → Minecraft</span> defaults until you switch it to <span className="font-bold text-[#00AF5C]">Custom</span>.
        </p>
        <div className="space-y-2.5">
          <OverrideSection icon={Maximize2} title="Game window" on={!!secOn.window} onToggle={() => toggleSection('window')}
            summary={`Using the global window size (${g.windowWidth}×${g.windowHeight}${g.fullscreen ? ', fullscreen' : ''}).`}>
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <NumberInput min={320} value={draft.windowWidth} onChange={(v) => setKey('windowWidth', v)} disabled={draft.fullscreen} />
              <span className="text-[var(--c-text-muted)] text-xs font-bold">×</span>
              <NumberInput min={240} value={draft.windowHeight} onChange={(v) => setKey('windowHeight', v)} disabled={draft.fullscreen} />
            </div>
            <div className="mt-3">
              <CheckRow checked={!!draft.fullscreen} onChange={(e) => setKey('fullscreen', e.target.checked)}>Launch in fullscreen</CheckRow>
            </div>
          </OverrideSection>

          <OverrideSection icon={Monitor} title="Launcher behavior" on={!!secOn.behavior} onToggle={() => toggleSection('behavior')}
            summary="Following the global launcher behavior (hide-to-tray / quit-on-close).">
            <div className="space-y-2.5">
              <CheckRow checked={draft.afterLaunch === 'hide'} onChange={(e) => setKey('afterLaunch', e.target.checked ? 'hide' : 'keep')}>
                Hide MineDash to the tray when the game opens
              </CheckRow>
              <CheckRow checked={!!draft.quitOnGameClose} onChange={(e) => setKey('quitOnGameClose', e.target.checked)}>
                Quit MineDash when the game closes
              </CheckRow>
            </div>
          </OverrideSection>

          <OverrideSection icon={SquareTerminal} title="Console window" on={!!secOn.console} onToggle={() => toggleSection('console')}
            summary="Using the global console preferences.">
            <div className="space-y-2.5">
              <CheckRow checked={!!draft.consoleShowOnLaunch} onChange={(e) => setKey('consoleShowOnLaunch', e.target.checked)}>Show the console when the game launches</CheckRow>
              <CheckRow checked={draft.consoleShowOnCrash !== false} onChange={(e) => setKey('consoleShowOnCrash', e.target.checked)}>Show the console when the game crashes</CheckRow>
              <CheckRow checked={!!draft.consoleHideOnExit} onChange={(e) => setKey('consoleHideOnExit', e.target.checked)}>Hide the console when the game exits</CheckRow>
            </div>
          </OverrideSection>

          <OverrideSection icon={Terminal} title="Custom commands" on={!!secOn.commands} onToggle={() => toggleSection('commands')}
            summary="No per-instance launch commands — using the global ones.">
            <div className="space-y-3">
              <div>
                <p className="text-[11px] uppercase tracking-wider font-bold text-[var(--c-text-muted)] mb-1.5">Pre-launch (non-zero exit aborts)</p>
                <MonoInput value={draft.preLaunchCommand} onChange={(v) => setKey('preLaunchCommand', v)} placeholder="e.g. python sync-mods.py" />
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wider font-bold text-[var(--c-text-muted)] mb-1.5">Post-exit</p>
                <MonoInput value={draft.postExitCommand} onChange={(v) => setKey('postExitCommand', v)} placeholder="e.g. python backup-world.py" />
              </div>
              <p className="text-[10px] text-[var(--c-text-muted)]">
                Variables: <code className="font-mono text-[#00AF5C]">$INST_NAME $INST_ID $INST_DIR $INST_MC_DIR $INST_JAVA</code>
              </p>
            </div>
          </OverrideSection>

          <OverrideSection icon={Braces} title="Environment variables" on={!!secOn.env} onToggle={() => toggleSection('env')}
            summary="Using the global environment variables.">
            <EnvVarsEditor value={draft.gameEnv} onChange={(v) => setKey('gameEnv', v)} />
          </OverrideSection>

          <OverrideSection icon={Wrench} title="Tweaks (native libraries)" on={!!secOn.tweaks} onToggle={() => toggleSection('tweaks')}
            summary="Using the bundled GLFW / OpenAL (global Tweaks).">
            <div className="space-y-4">
              <div className="space-y-2.5">
                <CheckRow checked={!!draft.useSystemGlfw} onChange={(e) => setKey('useSystemGlfw', e.target.checked)}>Use system installation of GLFW</CheckRow>
                {draft.useSystemGlfw && <MonoInput value={draft.glfwPath} onChange={(v) => setKey('glfwPath', v)} placeholder="Path to glfw library (e.g. C:\\Windows\\System32\\glfw.dll)" />}
              </div>
              <div className="space-y-2.5">
                <CheckRow checked={!!draft.useSystemOpenal} onChange={(e) => setKey('useSystemOpenal', e.target.checked)}>Use system installation of OpenAL</CheckRow>
                {draft.useSystemOpenal && <MonoInput value={draft.openalPath} onChange={(v) => setKey('openalPath', v)} placeholder="Path to OpenAL library (e.g. OpenAL32.dll)" />}
              </div>
            </div>
          </OverrideSection>
        </div>

        {ovDirty && (
          <div className="flex justify-end pt-3">
            <motion.button onClick={saveOverrides} disabled={savingOv} whileTap={{ scale: 0.97 }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold bg-[#00AF5C] hover:bg-[#00964F] text-white transition-colors disabled:opacity-50">
              {savingOv ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save overrides
            </motion.button>
          </div>
        )}
      </Field>

      {/* Files */}
      <Field label="Files">
        <div className="flex flex-wrap gap-2">
          <SecondaryButton icon={FolderOpen} label="Open folder" onClick={handleOpenFolder} />
          <SecondaryButton icon={FileDown} label="Export as .mrpack" onClick={handleExport} busy={exporting} />
        </div>
      </Field>

      {/* Danger zone */}
      <div className="border-t border-[var(--c-border)] pt-5">
        {confirmDelete ? (
          <div className="bg-[var(--c-danger)]/10 border border-[var(--c-danger)]/30 rounded-2xl p-4">
            <p className="text-sm font-bold text-[var(--c-text-primary)]">Delete this instance?</p>
            <p className="text-xs text-[var(--c-text-secondary)] mt-1">The on-disk profile (mods, worlds, configs) will be permanently removed.</p>
            <div className="flex items-center gap-2 mt-3">
              <button onClick={() => setConfirmDelete(false)} disabled={deleting}
                className="px-3 py-2 rounded-xl text-xs font-bold text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] bg-[var(--c-surface-2)] transition-colors disabled:opacity-50">
                Cancel
              </button>
              <motion.button onClick={handleDelete} disabled={deleting} whileTap={{ scale: 0.97 }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold bg-[var(--c-danger)] hover:bg-[var(--c-danger-hover)] text-white transition-colors disabled:opacity-50">
                {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete instance
              </motion.button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-bold text-[var(--c-danger)] hover:bg-[var(--c-danger)]/10 border border-[var(--c-danger)]/30 transition-colors">
            <Trash2 size={15} /> Delete instance
          </button>
        )}
      </div>
    </div>
  );
}
