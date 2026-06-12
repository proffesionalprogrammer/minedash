import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, RefreshCw, CheckCircle, AlertTriangle, ExternalLink, Loader2, Zap } from 'lucide-react';
import Tooltip from './Tooltip';

const adoptiumUrl = (major) =>
  `https://adoptium.net/temurin/releases/?version=${major}&os=windows&arch=x64&package=jdk`;

export default function JavaSetupModal({
  onClose,
  onProceedAnyway,
  socket,
  installedVersion,
  requiredMajor = 25,
  mcVersion = null,
}) {
  const [checking, setChecking] = useState(false);
  const [recheckResult, setRecheckResult] = useState(null); // null | 'ok' | 'still-missing'
  // Auto-install state — flips between a button row and a progress bar inside
  // the modal so the user doesn't have to leave to install Java.
  const [installSessionId, setInstallSessionId] = useState(null);
  const [installPhase, setInstallPhase] = useState(null); // null | 'metadata' | 'download' | 'extract' | 'done' | 'error'
  const [installPercent, setInstallPercent] = useState(0);
  const [installError, setInstallError] = useState(null);

  const installing = installPhase && installPhase !== 'done' && installPhase !== 'error';

  const openDownload = () => window.open(adoptiumUrl(requiredMajor), '_blank');

  // Subscribe to the install progress socket channel for the current session.
  useEffect(() => {
    if (!installSessionId || !socket) return;
    const channel = `java_install_${installSessionId}`;
    const handler = (p) => {
      if (p.phase) setInstallPhase(p.phase);
      if (typeof p.percent === 'number') setInstallPercent(p.percent);
      if (p.error) setInstallError(p.error);
      if (p.phase === 'done') {
        // Close after a short success state so the user sees the green check.
        setInstallPercent(100);
        setTimeout(onClose, 900);
      }
    };
    socket.on(channel, handler);
    return () => { socket.off(channel, handler); };
  }, [installSessionId, socket, onClose]);

  const installAutomatically = async () => {
    setInstallError(null);
    setInstallPhase('metadata');
    setInstallPercent(0);
    try {
      const res = await fetch('http://localhost:3001/api/java/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ major: requiredMajor }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Install request failed');
      if (data.alreadyInstalled) {
        setInstallPhase('done');
        setInstallPercent(100);
        setTimeout(onClose, 900);
        return;
      }
      setInstallSessionId(data.sessionId);
    } catch (err) {
      setInstallPhase('error');
      setInstallError(err.message);
    }
  };

  const recheck = async () => {
    setChecking(true);
    setRecheckResult(null);
    try {
      const qs = mcVersion ? `?version=${encodeURIComponent(mcVersion)}` : '';
      const res = await fetch(`http://localhost:3001/api/java-status${qs}`);
      const data = await res.json();
      if (data.ok) {
        setRecheckResult('ok');
        setTimeout(onClose, 1200);
      } else {
        setRecheckResult('still-missing');
      }
    } catch {
      setRecheckResult('still-missing');
    }
    setChecking(false);
  };

  const versionLabel = installedVersion
    ? `Java ${installedVersion} detected — Java ${requiredMajor} is required${mcVersion ? ` for Minecraft ${mcVersion}` : ''}.`
    : `Java ${requiredMajor} is required${mcVersion ? ` for Minecraft ${mcVersion}` : ''} but was not found on this computer.`;

  // Friendly label per phase for the progress bar.
  const phaseLabel = () => {
    if (installPhase === 'metadata') return 'Looking up the latest build…';
    if (installPhase === 'download') return `Downloading Java ${requiredMajor}…`;
    if (installPhase === 'extract') return 'Extracting…';
    if (installPhase === 'done') return 'Done! Closing…';
    if (installPhase === 'error') return installError || 'Install failed';
    return '';
  };

  return (
    <div className="fixed inset-0 bg-[#000000]/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        transition={{ type: 'spring', duration: 0.4, bounce: 0.15 }}
        className="bg-[#1A1A1A] border border-[#2D2D2D] rounded-3xl p-8 w-full max-w-lg shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-amber-500/10 rounded-xl">
              <AlertTriangle size={22} className="text-amber-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Java {requiredMajor} Required</h2>
              <p className="text-[#A0A0A0] text-sm mt-0.5">{versionLabel}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={installing}
            className="text-[#555555] hover:text-white transition-colors disabled:opacity-40"
          >
            <X size={20} />
          </button>
        </div>

        {/* Explanation */}
        <p className="text-[#A0A0A0] text-sm leading-relaxed mb-1">
          Minecraft servers run on Java.{' '}
          {mcVersion ? (
            <>
              Minecraft <span className="text-white font-bold">{mcVersion}</span> needs{' '}
              <span className="text-white font-bold">Java {requiredMajor}</span>.
            </>
          ) : (
            <>
              We recommend <span className="text-white font-bold">Java {requiredMajor}</span> for the latest Minecraft versions.
            </>
          )}{' '}
          MineDash can install it for you in one click, or you can do it manually.
        </p>
        <p className="text-amber-400/80 text-xs font-bold mb-6">
          ⚠ Your server will not start without a compatible Java version installed.
        </p>

        {/* Auto-install progress bar — replaces the steps + buttons while running */}
        {installPhase ? (
          <div className="mb-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-bold text-white flex items-center gap-2">
                {installPhase === 'done'
                  ? <CheckCircle size={16} className="text-[#00AF5C]" />
                  : installPhase === 'error'
                    ? <AlertTriangle size={16} className="text-[#FF5555]" />
                    : <Loader2 size={16} className="animate-spin text-[#00AF5C]" />}
                {phaseLabel()}
              </p>
              <span className="text-xs font-bold text-[#A0A0A0] tabular-nums">{installPercent}%</span>
            </div>
            <div className="h-2 bg-[#2D2D2D] rounded-full overflow-hidden">
              <motion.div
                className={`h-full rounded-full ${installPhase === 'error' ? 'bg-[#FF5555]' : 'bg-[#00AF5C]'}`}
                initial={{ width: 0 }}
                animate={{ width: `${installPercent}%` }}
                transition={{ duration: 0.2 }}
              />
            </div>
            {installPhase === 'error' && (
              <button
                onClick={() => { setInstallPhase(null); setInstallSessionId(null); setInstallError(null); setInstallPercent(0); }}
                className="mt-4 text-xs font-bold text-[#A0A0A0] hover:text-white transition-colors"
              >
                ← Back to install options
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Steps */}
            <div className="space-y-3 mb-6">
              {[
                { n: 1, text: 'Click "Install automatically" — MineDash fetches the right Java from Adoptium' },
                { n: 2, text: 'Wait about 1–2 minutes while it downloads (~180 MB) and extracts' },
                { n: 3, text: 'Your server will use this Java automatically — nothing else to configure' },
              ].map(({ n, text }) => (
                <div key={n} className="flex items-start gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#00AF5C]/15 border border-[#00AF5C]/30 text-[#00AF5C] text-xs font-bold flex items-center justify-center mt-0.5">
                    {n}
                  </span>
                  <p className="text-[#A0A0A0] text-sm leading-relaxed">{text}</p>
                </div>
              ))}
            </div>

            {/* Recheck feedback (only shown when user used the manual path) */}
            <AnimatePresence>
              {recheckResult === 'ok' && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 text-[#00AF5C] text-sm font-bold mb-4"
                >
                  <CheckCircle size={16} /> Java found! Closing…
                </motion.div>
              )}
              {recheckResult === 'still-missing' && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 text-[#FF5555] text-sm font-bold mb-4"
                >
                  <AlertTriangle size={16} /> Java still not detected. Make sure the installer finished, then try again.
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}

        {/* Primary actions — hidden during install */}
        {!installPhase && (
          <>
            <div className="flex items-center gap-3 pt-4 border-t border-[#2D2D2D]">
              <motion.button
                whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                onClick={installAutomatically}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-colors shadow-[0_4px_12px_rgba(0,175,92,0.2)]"
              >
                <Zap size={16} />
                Install automatically
              </motion.button>

              <Tooltip content="Download from adoptium.net manually">
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={openDownload}
                  className="flex items-center gap-2 px-4 py-2.5 bg-[#2D2D2D] hover:bg-[#3D3D3D] text-white rounded-xl font-bold text-sm transition-colors"
                >
                  <Download size={15} />
                  Manual
                  <ExternalLink size={12} className="opacity-60" />
                </motion.button>
              </Tooltip>

              <Tooltip content="Re-scan for an existing Java install" align="end">
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={recheck}
                  disabled={checking}
                  className="flex items-center gap-2 px-3 py-2.5 bg-[#2D2D2D] hover:bg-[#3D3D3D] disabled:opacity-50 text-white rounded-xl font-bold text-sm transition-colors"
                >
                  <RefreshCw size={15} className={checking ? 'animate-spin' : ''} />
                </motion.button>
              </Tooltip>
            </div>

            {/* Escape hatch */}
            <div className="mt-3 text-center">
              <button
                onClick={onProceedAnyway}
                className="text-[#555555] hover:text-[#A0A0A0] text-xs transition-colors"
              >
                I know what I'm doing — continue anyway
              </button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}
