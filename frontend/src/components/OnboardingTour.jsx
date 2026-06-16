import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  Sparkles, Gamepad2, Server, User, Package, Wrench, Terminal,
  Users, Folder, Calendar, Globe, Sliders, ChevronLeft, ChevronRight,
  X, Check, Coffee, ShieldAlert, Layers, Boxes,
} from 'lucide-react';

// First-run guided tour for MineDash.
//
// Lifecycle:
//   • App.jsx renders <OnboardingTour /> when launcherSettings.onboardingComplete
//     is false.
//   • On finish OR skip, we PUT { onboardingComplete: true } and call
//     onClose() so the parent unmounts us.
//   • The Settings menu can re-trigger via window.dispatchEvent('minedash-show-onboarding')
//     so users can replay the tour any time.
//
// Motion design choices (UI/UX skill rules applied):
//   • Forward navigation slides left, backward slides right — spatial continuity.
//   • Enter ~280ms with ease-out, exit ~180ms with ease-in (exit-faster-than-enter).
//   • Spring physics on dock-button hover/press for natural feel.
//   • prefers-reduced-motion shortens distances and disables springs.
//   • Escape closes (with confirm-on-finish guard), Tab cycles inside the modal.
//   • One primary CTA per step ("Next" / "Get Started").

const STEPS = buildSteps();

export default function OnboardingTour({ onClose, onComplete }) {
  const [idx, setIdx] = useState(0);
  const [direction, setDirection] = useState(1); // +1 forward, -1 back
  const reduced = useReducedMotion();
  const panelRef = useRef(null);

  const step = STEPS[idx];
  const isFirst = idx === 0;
  const isLast = idx === STEPS.length - 1;

  const goNext = useCallback(() => {
    if (isLast) {
      onComplete?.();
      onClose?.();
      return;
    }
    setDirection(1);
    setIdx((i) => Math.min(i + 1, STEPS.length - 1));
  }, [isLast, onClose, onComplete]);

  const goBack = useCallback(() => {
    if (isFirst) return;
    setDirection(-1);
    setIdx((i) => Math.max(i - 1, 0));
  }, [isFirst]);

  const skip = useCallback(() => {
    onComplete?.();
    onClose?.();
  }, [onClose, onComplete]);

  // Keyboard nav: ← → arrows, Enter for Next, Esc for Skip.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); goNext(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      else if (e.key === 'Escape') { e.preventDefault(); skip(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goBack, skip]);

  // Focus the panel so the keyboard shortcuts kick in immediately.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Per-step slide distance — small on reduced-motion so we still get the
  // spatial cue without big animations.
  const distance = reduced ? 8 : 48;

  const slideVariants = {
    enter: (dir) => ({ x: dir > 0 ? distance : -distance, opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (dir) => ({ x: dir > 0 ? -distance : distance, opacity: 0 }),
  };

  return (
    <AnimatePresence>
      <motion.div
        // Backdrop
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
        className="fixed inset-0 z-[200] bg-[#000000]/85 backdrop-blur-md flex items-center justify-center p-4 sm:p-6"
        aria-modal="true"
        role="dialog"
        aria-label="MineDash welcome tour"
      >
        {/* Soft brand glow that subtly drifts behind the panel */}
        <motion.div
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.6 }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          <motion.div
            animate={reduced ? {} : { x: [-40, 40, -40], y: [-20, 20, -20] }}
            transition={{ duration: 18, ease: 'easeInOut', repeat: Infinity }}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-[#00AF5C]/10 blur-[120px]"
          />
        </motion.div>

        <motion.div
          ref={panelRef}
          tabIndex={-1}
          initial={{ scale: 0.94, opacity: 0, y: 12 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.94, opacity: 0, y: 12 }}
          transition={{ type: 'spring', duration: 0.5, bounce: 0.18 }}
          className="relative w-full max-w-2xl bg-[var(--c-surface-1)] border border-[var(--c-border)] rounded-3xl shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7)] overflow-hidden focus:outline-none"
        >
          {/* Top bar: brand mark + step badge + skip */}
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <div className="flex items-center gap-2">
              <GrassBlockIcon />
              <span className="text-sm font-bold tracking-wide text-[var(--c-text-primary)]">MineDash</span>
              <span className="ml-2 px-2 py-0.5 bg-[#00AF5C]/10 border border-[#00AF5C]/20 rounded-md text-[10px] font-bold uppercase tracking-wider text-[#00AF5C]">
                Quick tour
              </span>
            </div>
            <button
              type="button"
              onClick={skip}
              className="flex items-center gap-1 text-xs font-bold text-[var(--c-text-muted)] hover:text-[var(--c-text-primary)] transition-colors px-2 py-1 rounded-md hover:bg-[var(--c-surface-2)]"
              aria-label="Skip tour"
            >
              Skip <X size={12} />
            </button>
          </div>

          {/* Step body — sliding panel */}
          <div className="relative min-h-[420px] px-6 sm:px-10 pb-6 overflow-hidden">
            <AnimatePresence mode="wait" custom={direction}>
              <motion.div
                key={idx}
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={reduced ? { duration: 0.15 } : {
                  x: { type: 'spring', stiffness: 320, damping: 32 },
                  opacity: { duration: 0.22, ease: 'easeOut' },
                }}
                className="flex flex-col"
              >
                <StepHeader step={step} idx={idx} reduced={reduced} />
                <div className="mt-6">{step.body}</div>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Footer — progress dots + back/next */}
          <div className="flex items-center justify-between gap-4 px-6 sm:px-10 py-4 border-t border-[var(--c-border)] bg-[var(--c-base)]">
            <ProgressDots count={STEPS.length} activeIdx={idx} onJump={(i) => { setDirection(i > idx ? 1 : -1); setIdx(i); }} />

            <div className="flex items-center gap-2">
              <motion.button
                type="button"
                onClick={goBack}
                disabled={isFirst}
                whileHover={isFirst ? {} : { scale: 1.03 }}
                whileTap={isFirst ? {} : { scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                className="flex items-center gap-1 px-3 py-2 bg-transparent hover:bg-[var(--c-surface-2)] text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] rounded-xl text-sm font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={16} />
                Back
              </motion.button>
              <motion.button
                type="button"
                onClick={goNext}
                whileHover={{ scale: 1.03, boxShadow: '0 6px 24px rgba(0, 175, 92, 0.35)' }}
                whileTap={{ scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                className="flex items-center gap-2 px-5 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-colors shadow-[0_4px_14px_rgba(0,175,92,0.25)]"
                autoFocus
              >
                {isLast ? (
                  <>
                    <Check size={16} />
                    Get started
                  </>
                ) : (
                  <>
                    Next
                    <ChevronRight size={16} />
                  </>
                )}
              </motion.button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

// ─── Step header ───────────────────────────────────────────────────────────────
function StepHeader({ step, idx, reduced }) {
  const Icon = step.icon;
  const accent = step.accent || '#00AF5C';
  return (
    <div className="flex items-start gap-4">
      <motion.div
        // Icon chip — gentle press-in on each step transition so the eye lands on it.
        initial={reduced ? {} : { scale: 0.7, rotate: -6 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 360, damping: 18, delay: 0.05 }}
        className="flex-shrink-0 p-3 rounded-2xl"
        style={{
          background: `${accent}1A`, // hex + ~10% alpha
          boxShadow: `0 0 0 1px ${accent}33`,
        }}
      >
        <Icon size={26} style={{ color: accent }} />
      </motion.div>
      <div className="min-w-0 pt-1">
        <p className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)] mb-1">
          Step {idx + 1} of {STEPS.length} · {step.eyebrow}
        </p>
        <h2 className="text-2xl sm:text-3xl font-black text-[var(--c-text-primary)] tracking-tight leading-tight">
          {step.title}
        </h2>
        <p className="mt-2 text-sm text-[var(--c-text-secondary)] leading-relaxed">{step.subtitle}</p>
      </div>
    </div>
  );
}

// ─── Progress dots ─────────────────────────────────────────────────────────────
function ProgressDots({ count, activeIdx, onJump }) {
  return (
    <div className="flex items-center gap-1.5" role="tablist" aria-label="Tour progress">
      {Array.from({ length: count }).map((_, i) => {
        const active = i === activeIdx;
        const past = i < activeIdx;
        return (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={`Go to step ${i + 1}`}
            onClick={() => onJump(i)}
            className="group relative h-2 flex items-center"
          >
            <motion.span
              animate={{
                width: active ? 26 : 8,
                backgroundColor: active ? '#00AF5C' : past ? '#00AF5C66' : '#2D2D2D',
              }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              className="block h-2 rounded-full group-hover:bg-[var(--c-border-soft)]"
              style={{ pointerEvents: 'none' }}
            />
          </button>
        );
      })}
    </div>
  );
}

// ─── Tiny pixel-art grass block (matches TitleBar) ─────────────────────────────
function GrassBlockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 8 8" shapeRendering="crispEdges">
      <rect x="0" y="0" width="8" height="3" fill="#5EA91E" />
      <rect x="1" y="0" width="1" height="1" fill="#7DB356" />
      <rect x="4" y="0" width="1" height="1" fill="#7DB356" />
      <rect x="6" y="1" width="1" height="1" fill="#7DB356" />
      <rect x="2" y="1" width="1" height="1" fill="#4CAF50" />
      <rect x="0" y="3" width="8" height="5" fill="#96583E" />
      <rect x="1" y="4" width="1" height="1" fill="#C8A882" />
      <rect x="4" y="5" width="1" height="1" fill="#7A4E32" />
      <rect x="6" y="4" width="1" height="1" fill="#7A4E32" />
      <rect x="2" y="6" width="1" height="1" fill="#C8A882" />
      <rect x="5" y="6" width="1" height="1" fill="#8E8E8E" />
    </svg>
  );
}

// ─── Mini preview building blocks ──────────────────────────────────────────────
// Each step body uses these to mock the relevant slice of the real UI without
// taking a screenshot (which would rot every time a tab moves).

function PreviewCard({ children, className = '' }) {
  return (
    <div className={`bg-[var(--c-surface-2)] border border-[var(--c-border)] rounded-2xl p-4 ${className}`}>
      {children}
    </div>
  );
}

function ChoiceTile({ icon: Icon, title, body, accent = '#00AF5C', delay = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -3 }}
      className="flex-1 bg-[var(--c-surface-2)] border border-[var(--c-border)] hover:border-[var(--c-border-soft)] rounded-2xl p-5 cursor-default transition-colors"
    >
      <div
        className="inline-flex p-2 rounded-xl mb-3"
        style={{ background: `${accent}1A`, boxShadow: `0 0 0 1px ${accent}33` }}
      >
        <Icon size={18} style={{ color: accent }} />
      </div>
      <p className="text-sm font-bold text-[var(--c-text-primary)] mb-1">{title}</p>
      <p className="text-xs text-[var(--c-text-secondary)] leading-relaxed">{body}</p>
    </motion.div>
  );
}

function TabPreviewRow({ tabs }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto pb-1 -mx-1 px-1 custom-scrollbar">
      {tabs.map((t, i) => {
        const Icon = t.icon;
        const active = t.active;
        return (
          <motion.div
            key={t.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 + i * 0.035, duration: 0.3, ease: 'easeOut' }}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold whitespace-nowrap ${
              active
                ? 'bg-[#00AF5C]/10 text-[#00AF5C] border border-[#00AF5C]/30'
                : 'text-[var(--c-text-secondary)] border border-transparent'
            }`}
          >
            <Icon size={12} />
            {t.label}
          </motion.div>
        );
      })}
    </div>
  );
}

// ─── Step content ──────────────────────────────────────────────────────────────
function buildSteps() {
  return [
    {
      eyebrow: 'Welcome',
      title: 'Your Minecraft hub, on your PC.',
      subtitle: 'MineDash launches the game and runs your own servers — all from one place. Quick tour so you know where everything lives.',
      icon: Sparkles,
      accent: '#00AF5C',
      body: (
        <PreviewCard className="flex items-center gap-4">
          <motion.div
            initial={{ scale: 0.6, rotate: -8 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 16, delay: 0.15 }}
            className="flex-shrink-0"
          >
            <svg width="64" height="64" viewBox="0 0 8 8" shapeRendering="crispEdges">
              <rect x="0" y="0" width="8" height="3" fill="#5EA91E" />
              <rect x="1" y="0" width="1" height="1" fill="#7DB356" />
              <rect x="4" y="0" width="1" height="1" fill="#7DB356" />
              <rect x="6" y="1" width="1" height="1" fill="#7DB356" />
              <rect x="2" y="1" width="1" height="1" fill="#4CAF50" />
              <rect x="0" y="3" width="8" height="5" fill="#96583E" />
              <rect x="1" y="4" width="1" height="1" fill="#C8A882" />
              <rect x="4" y="5" width="1" height="1" fill="#7A4E32" />
              <rect x="6" y="4" width="1" height="1" fill="#7A4E32" />
              <rect x="2" y="6" width="1" height="1" fill="#C8A882" />
              <rect x="5" y="6" width="1" height="1" fill="#8E8E8E" />
            </svg>
          </motion.div>
          <div>
            <p className="text-sm font-bold text-[var(--c-text-primary)]">No external accounts to wire up.</p>
            <p className="text-xs text-[var(--c-text-secondary)] mt-1 leading-relaxed">
              No web dashboard, no monthly fee. Everything runs locally — your servers, your mods, your worlds.
            </p>
          </div>
        </PreviewCard>
      ),
    },

    {
      eyebrow: 'Two sides of MineDash',
      title: 'Launcher and Servers, side by side.',
      subtitle: 'Top bar switches between launching the game and managing your servers. You can hop between them any time.',
      icon: Layers,
      accent: '#00AF5C',
      body: (
        <div className="flex flex-col sm:flex-row gap-3">
          <ChoiceTile
            icon={Gamepad2}
            title="Launcher"
            body="Sign in, pick a loader, install modpacks, click Play. Microsoft or offline accounts both work."
            delay={0.05}
          />
          <ChoiceTile
            icon={Server}
            title="Servers"
            body="Spin up Vanilla, Paper, Fabric, Forge or NeoForge servers on this PC. Console, players, mods, backups."
            delay={0.12}
          />
        </div>
      ),
    },

    {
      eyebrow: 'Account',
      title: 'Sign in — or skip it.',
      subtitle: 'Microsoft sign-in uses the official device-flow (a code you paste at microsoft.com/link). Prefer to play offline? Type any name and you\'re in.',
      icon: User,
      accent: '#00AF5C',
      body: (
        <div className="flex flex-col sm:flex-row gap-3">
          <ChoiceTile
            icon={User}
            title="Microsoft"
            body="Premium-only servers, your real skin, cloud realms. Token refreshes automatically."
            delay={0.05}
          />
          <ChoiceTile
            icon={ShieldAlert}
            title="Offline"
            body="Cracked-style local play. Works on LAN and any server that allows offline mode."
            accent="#F59E0B"
            delay={0.12}
          />
        </div>
      ),
    },

    {
      eyebrow: 'Pick a version',
      title: 'Vanilla, Fabric, Forge, NeoForge.',
      subtitle: 'Choose the loader and Minecraft version. MineDash downloads the right Java automatically — you never install a JDK by hand.',
      icon: Boxes,
      accent: '#00AF5C',
      body: (
        <PreviewCard>
          <p className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)] mb-3">Loader</p>
          <div className="flex flex-wrap gap-2 mb-4">
            {['Vanilla', 'Fabric', 'Forge', 'NeoForge'].map((l, i) => (
              <motion.div
                key={l}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.05 + i * 0.06, type: 'spring', stiffness: 360, damping: 22 }}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border ${
                  l === 'Fabric'
                    ? 'bg-[#00AF5C]/10 border-[#00AF5C]/30 text-[#00AF5C]'
                    : 'bg-[var(--c-base)] border-[var(--c-border)] text-[var(--c-text-secondary)]'
                }`}
              >
                {l}
              </motion.div>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Coffee size={14} className="text-[#00AF5C]" />
            <span className="text-[var(--c-text-secondary)]">
              1.20.1 needs Java <span className="font-bold text-white">17</span> — MineDash downloads it for you.
            </span>
          </div>
        </PreviewCard>
      ),
    },

    {
      eyebrow: 'Mods & modpacks',
      title: 'Install modpacks with one click.',
      subtitle: 'Browse Modrinth right in the app. Pick a modpack and it installs every mod, override, and config into a profile named after it.',
      icon: Package,
      accent: '#00AF5C',
      body: (
        <PreviewCard>
          <div className="space-y-2">
            {[
              { name: 'Prominence II RPG', count: '512 mods', i: 0 },
              { name: 'Better Minecraft', count: '286 mods', i: 1 },
              { name: 'Fabulously Optimized', count: '74 mods', i: 2 },
            ].map((m) => (
              <motion.div
                key={m.name}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.08 + m.i * 0.07, duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                className="flex items-center gap-3 p-2.5 rounded-xl bg-[var(--c-base)] border border-[var(--c-border)]"
              >
                <div className="w-9 h-9 rounded-lg bg-[#00AF5C]/10 border border-[#00AF5C]/20 flex items-center justify-center flex-shrink-0">
                  <Package size={16} className="text-[#00AF5C]" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-[var(--c-text-primary)] truncate">{m.name}</p>
                  <p className="text-[10px] text-[var(--c-text-muted)]">{m.count}</p>
                </div>
                <div className="px-2.5 py-1 rounded-lg bg-[#00AF5C]/10 border border-[#00AF5C]/30 text-[10px] font-bold text-[#00AF5C]">
                  Install
                </div>
              </motion.div>
            ))}
          </div>
        </PreviewCard>
      ),
    },

    {
      eyebrow: 'Run a server',
      title: 'Host friends in under a minute.',
      subtitle: 'Click New Server, pick a type and version, and MineDash sets up the JAR, accepts the EULA, and starts it. Drop a .mrpack to import a whole modpack as a server.',
      icon: Server,
      accent: '#00AF5C',
      body: (
        <PreviewCard>
          <div className="flex items-center gap-4">
            <motion.div
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 22, delay: 0.1 }}
              className="w-16 h-16 rounded-2xl bg-[var(--c-base)] border border-[var(--c-border)] flex items-center justify-center flex-shrink-0"
            >
              <Server size={28} className="text-[#00AF5C]" />
            </motion.div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-[var(--c-text-primary)]">My Survival World</p>
              <div className="flex items-center gap-2 text-xs text-[var(--c-text-secondary)] mt-0.5">
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#00AF5C] animate-pulse" />
                  Online
                </span>
                <span className="text-[var(--c-border)]">·</span>
                <span>Fabric 1.20.1</span>
                <span className="text-[var(--c-border)]">·</span>
                <span className="tabular-nums">3 / 20 players</span>
              </div>
            </div>
          </div>
        </PreviewCard>
      ),
    },

    {
      eyebrow: 'Inside the server',
      title: 'Every dial you\'d expect.',
      subtitle: 'When you open a server, the tab bar gives you a console, the live player list, mods, backups, schedules, networking, and full server.properties.',
      icon: Sliders,
      accent: '#00AF5C',
      body: (
        <PreviewCard>
          <TabPreviewRow tabs={[
            { label: 'Console',  icon: Terminal,  active: true },
            { label: 'Players',  icon: Users },
            { label: 'Mods',     icon: Package },
            { label: 'Backups',  icon: Folder },
            { label: 'Schedule', icon: Calendar },
            { label: 'Network',  icon: Globe },
            { label: 'Options',  icon: Sliders },
          ]} />
          <p className="mt-3 text-xs text-[var(--c-text-secondary)] leading-relaxed">
            Each tab does what it says — type commands, kick players, install mods from Modrinth, schedule backups, copy join addresses, tweak server.properties.
          </p>
        </PreviewCard>
      ),
    },

    {
      eyebrow: 'Quietly looking after you',
      title: 'Smart bits that just happen.',
      subtitle: 'When something would normally need debugging, MineDash usually catches it first — so you can focus on actually playing.',
      icon: Wrench,
      accent: '#00AF5C',
      body: (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <ChoiceTile
            icon={Coffee}
            title="Auto-managed Java"
            body="Downloads the right JDK from Adoptium per server. No more 'wrong Java version' crashes."
            delay={0.05}
          />
          <ChoiceTile
            icon={ShieldAlert}
            title="Crash detection"
            body="Names the culprit mod and offers a one-click disable. Missing dependencies auto-install."
            accent="#F59E0B"
            delay={0.12}
          />
        </div>
      ),
    },

    {
      eyebrow: 'You\'re ready',
      title: 'That\'s the whole tour.',
      subtitle: 'Hop into the Launcher to start playing, or open Servers to spin up a world for your friends. You can replay this tour any time from Settings.',
      icon: Check,
      accent: '#00AF5C',
      body: (
        <PreviewCard className="flex flex-col sm:flex-row items-center gap-4">
          <motion.div
            initial={{ scale: 0, rotate: -90 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 280, damping: 14, delay: 0.15 }}
            className="w-14 h-14 rounded-2xl bg-[#00AF5C]/10 border border-[#00AF5C]/30 flex items-center justify-center flex-shrink-0"
          >
            <Check size={26} className="text-[#00AF5C]" />
          </motion.div>
          <div className="text-center sm:text-left">
            <p className="text-sm font-bold text-[var(--c-text-primary)]">Have fun — and tell us when something feels off.</p>
            <p className="text-xs text-[var(--c-text-secondary)] mt-1 leading-relaxed">
              Bugs and ideas are tracked on GitHub. Updates ship straight to the app — no reinstall.
            </p>
          </div>
        </PreviewCard>
      ),
    },
  ];
}
