import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, RefreshCw, CheckCircle, AlertTriangle, ExternalLink } from 'lucide-react';

const adoptiumUrl = (major) =>
  `https://adoptium.net/temurin/releases/?version=${major}&os=windows&arch=x64&package=jdk`;

export default function JavaSetupModal({
  onClose,
  onProceedAnyway,
  installedVersion,
  requiredMajor = 25,
  mcVersion = null,
}) {
  const [checking, setChecking] = useState(false);
  const [recheckResult, setRecheckResult] = useState(null); // null | 'ok' | 'still-missing'

  const openDownload = () => window.open(adoptiumUrl(requiredMajor), '_blank');

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
    ? `Java ${installedVersion} detected — Java ${requiredMajor} or newer is required${mcVersion ? ` for Minecraft ${mcVersion}` : ''}.`
    : `Java ${requiredMajor} is required${mcVersion ? ` for Minecraft ${mcVersion}` : ''} but was not found on this computer.`;

  return (
    <div className="fixed inset-0 bg-[#000000]/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
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
          <button onClick={onClose} className="text-[#555555] hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Explanation */}
        <p className="text-[#A0A0A0] text-sm leading-relaxed mb-1">
          Minecraft servers run on Java.{' '}
          {mcVersion ? (
            <>
              Minecraft <span className="text-white font-bold">{mcVersion}</span> needs{' '}
              <span className="text-white font-bold">Java {requiredMajor}</span> or newer.
            </>
          ) : (
            <>
              We recommend <span className="text-white font-bold">Java {requiredMajor}</span> for the latest Minecraft versions.
            </>
          )}{' '}
          Installation is free and takes about 2 minutes.
        </p>
        <p className="text-amber-400/80 text-xs font-bold mb-6">
          ⚠ Your server will not start without a compatible Java version installed.
        </p>

        {/* Steps */}
        <div className="space-y-3 mb-6">
          {[
            { n: 1, text: 'Click "Download Java" below — it opens the Adoptium website' },
            { n: 2, text: 'Download the .msi installer for Windows and run it' },
            { n: 3, text: 'Follow the installer prompts (keep all defaults)' },
            { n: 4, text: 'Come back here and click "I\'ve Installed Java"' },
          ].map(({ n, text }) => (
            <div key={n} className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#00AF5C]/15 border border-[#00AF5C]/30 text-[#00AF5C] text-xs font-bold flex items-center justify-center mt-0.5">
                {n}
              </span>
              <p className="text-[#A0A0A0] text-sm leading-relaxed">{text}</p>
            </div>
          ))}
        </div>

        {/* Recheck feedback */}
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

        {/* Primary actions */}
        <div className="flex items-center gap-3 pt-4 border-t border-[#2D2D2D]">
          <motion.button
            whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={openDownload}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-colors"
          >
            <Download size={16} />
            Download Java {requiredMajor}
            <ExternalLink size={13} className="opacity-60" />
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            onClick={recheck}
            disabled={checking}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#2D2D2D] hover:bg-[#3D3D3D] disabled:opacity-50 text-white rounded-xl font-bold text-sm transition-colors"
          >
            <RefreshCw size={15} className={checking ? 'animate-spin' : ''} />
            {checking ? 'Checking…' : "I've Installed Java"}
          </motion.button>
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
      </motion.div>
    </div>
  );
}
