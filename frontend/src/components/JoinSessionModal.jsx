import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Zap, Copy, Check, X, Loader2, Gamepad2 } from 'lucide-react';
import { modalBackdrop, modalPanel } from '../lib/motion';
import ModalPortal from './ModalPortal';
import { TITLEBAR_OFFSET } from '../lib/titlebar';

const API = 'http://localhost:3001';

// Join a friend's MineDash Connect session. Zero-infra serverless WebRTC: paste
// the host's invite code, get a reply code to send back, and once the host
// applies it the tunnel comes up and Minecraft connects to a local port.
export default function JoinSessionModal({ socket, connectSession, onConnected, onDisconnect, onClose }) {
  // paste | reply | connected | failed. Reopening the window while a tunnel is
  // already live (the friend closed it to play, then came back) restores the
  // connected view straight from the lifted session, instead of a fresh paste.
  const [step, setStep] = useState(connectSession ? 'connected' : 'paste');
  const [inviteInput, setInviteInput] = useState('');
  const [sessionId, setSessionId] = useState(connectSession?.sessionId ?? null);
  const [replyCode, setReplyCode] = useState('');
  const [localPort, setLocalPort] = useState(connectSession?.localPort ?? null);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null);

  const copyText = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  // Live status for this join session.
  useEffect(() => {
    if (!sessionId || !socket) return;
    const channel = `connect_status_${sessionId}`;
    const handler = (p) => {
      if (p.state === 'connected') {
        setLocalPort(p.localPort);
        setStep('connected');
        // Lift the live session up so it outlives this window.
        onConnected?.({ sessionId, localPort: p.localPort });
      }
      else if (p.state === 'failed') { setDetail(p.detail || 'Connection failed.'); setStep('failed'); }
    };
    socket.on(channel, handler);
    return () => socket.off(channel, handler);
  }, [sessionId, socket, onConnected]);

  const submitInvite = async () => {
    const code = inviteInput.trim();
    if (!code) return;
    setBusy(true);
    setDetail('');
    try {
      const res = await fetch(`${API}/api/connect/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid invite code');
      setSessionId(data.sessionId);
      setReplyCode(data.replyCode);
      setStep('reply');
    } catch (e) {
      setDetail(e.message);
    }
    setBusy(false);
  };

  // Closing the window must NOT kill a live tunnel — the friend has to leave
  // this modal to reach the Launcher and start the game. Once connected the
  // session is owned by App (and shown in the floating indicator); only an
  // explicit Disconnect ends it. A not-yet-connected attempt is still torn
  // down so abandoned half-handshakes don't linger.
  const close = async () => {
    if (step === 'connected') { onClose(); return; }
    const id = sessionId;
    if (id) { try { await fetch(`${API}/api/connect/${id}`, { method: 'DELETE' }); } catch {} }
    onClose();
  };

  const disconnect = async () => {
    await onDisconnect?.();
    onClose();
  };

  const reset = () => {
    setStep('paste');
    setSessionId(null);
    setReplyCode('');
    setLocalPort(null);
    setDetail('');
    setInviteInput('');
  };

  // Use 127.0.0.1 (not "localhost"): the tunnel listener binds IPv4 loopback, but
  // on many Windows machines "localhost" resolves to IPv6 ::1 first — Minecraft
  // then connects to [::1]:port, nothing is listening there, and Java reports a
  // "Connection refused: getsockopt". 127.0.0.1 forces the matching IPv4 path.
  const address = localPort != null ? `127.0.0.1:${localPort}` : '';

  return (
    <ModalPortal>
      <motion.div
        variants={modalBackdrop} initial="initial" animate="animate" exit="exit"
        className="fixed inset-x-0 bottom-0 bg-[#000000]/80 z-50 flex items-center justify-center backdrop-blur-sm"
        style={{ top: TITLEBAR_OFFSET }}
        onClick={() => !busy && close()}
      >
        <motion.div
          variants={modalPanel} initial="initial" animate="animate" exit="exit"
          className="bg-[var(--c-surface-1)] border border-[var(--c-border)] p-8 rounded-3xl w-full max-w-lg shadow-2xl mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-[#00AF5C]/10 rounded-xl">
                <Zap size={18} className="text-[#00AF5C]" />
              </div>
              <h3 className="text-lg font-bold text-[var(--c-text-primary)]">Join a friend</h3>
              <span className="px-1.5 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[9px] font-bold uppercase tracking-wider">
                Beta
              </span>
            </div>
            <button
              onClick={() => !busy && close()}
              className="p-1.5 text-[var(--c-text-secondary)] hover:text-[var(--c-text-primary)] hover:bg-[var(--c-border)] rounded-lg transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* Step: paste invite code */}
          {step === 'paste' && (
            <>
              <p className="text-sm text-[var(--c-text-secondary)] mb-4 leading-relaxed">
                Paste the invite code your friend gave you. You'll get a reply code to send back — once they paste it, you'll connect automatically.
              </p>
              <label className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)]">Invite code</label>
              <textarea
                autoFocus
                value={inviteInput}
                onChange={(e) => { setInviteInput(e.target.value); if (detail) setDetail(''); }}
                placeholder="Paste your friend's invite code here…"
                className="w-full h-24 mt-1.5 bg-[var(--c-base)] border border-[var(--c-border)] focus:border-[#00AF5C] focus:ring-4 focus:ring-[#00AF5C]/10 rounded-xl px-3 py-2 font-mono text-xs text-[var(--c-text-primary)] resize-none custom-scrollbar outline-none transition-all placeholder-[var(--c-text-muted)]"
              />
              {detail && <p className="text-xs text-[var(--c-danger)] font-medium mt-2">{detail}</p>}
              <div className="flex justify-end gap-3 pt-5 mt-5 border-t border-[var(--c-border)]">
                <button
                  onClick={close}
                  className="px-4 py-2 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] text-[var(--c-text-primary)] rounded-xl text-sm font-bold transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={submitInvite}
                  disabled={busy || !inviteInput.trim()}
                  className="px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-all flex items-center gap-2 disabled:opacity-50"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                  {busy ? 'Working…' : 'Connect'}
                </button>
              </div>
            </>
          )}

          {/* Step: show reply code, awaiting host */}
          {step === 'reply' && (
            <>
              <p className="text-sm text-[var(--c-text-secondary)] mb-4 leading-relaxed">
                Send this reply code back to your host. As soon as they paste it into MineDash, you'll connect.
              </p>
              <label className="text-[10px] uppercase tracking-wider font-bold text-[var(--c-text-muted)]">Reply code</label>
              <div className="flex items-stretch gap-2 mt-1.5">
                <textarea
                  readOnly
                  value={replyCode}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 h-24 bg-[var(--c-base)] border border-[var(--c-border)] rounded-xl px-3 py-2 font-mono text-xs text-[var(--c-text-secondary)] resize-none custom-scrollbar outline-none"
                />
                <button
                  onClick={() => copyText(replyCode, 'reply')}
                  className="px-4 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold text-sm transition-all active:scale-95 flex items-center gap-2 flex-shrink-0"
                >
                  {copied === 'reply' ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
              <div className="flex items-center gap-2 text-sm text-[var(--c-text-secondary)] pt-5 mt-5 border-t border-[var(--c-border)]">
                <Loader2 size={16} className="animate-spin text-[#00AF5C]" />
                Waiting for your host to connect…
              </div>
            </>
          )}

          {/* Step: connected */}
          {step === 'connected' && (
            <>
              <div className="flex items-center gap-2 mb-4">
                <Check size={16} className="text-[#00AF5C]" />
                <span className="text-sm font-bold text-[#00AF5C]">Connected!</span>
              </div>
              <p className="text-sm text-[var(--c-text-secondary)] mb-3 leading-relaxed flex items-center gap-2">
                <Gamepad2 size={16} className="text-[var(--c-text-secondary)]" />
                In Minecraft, go to Multiplayer → Add Server and use this address:
              </p>
              <div className="flex items-center gap-4">
                <div className="flex-1 bg-[var(--c-base)] border border-[var(--c-border)] rounded-xl px-5 py-3.5 font-mono text-xl text-[var(--c-text-primary)] font-bold tracking-wide">
                  {address}
                </div>
                <button
                  onClick={() => copyText(address, 'addr')}
                  className="px-5 py-3.5 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl font-bold transition-all active:scale-95 flex items-center gap-2 flex-shrink-0"
                >
                  {copied === 'addr' ? <><Check size={18} />Copied!</> : <><Copy size={18} />Copy</>}
                </button>
              </div>
              <p className="text-xs text-[var(--c-text-muted)] mt-3">
                You can close this window and head to the Launcher — the connection stays open until you disconnect.
              </p>
              <div className="flex justify-end gap-3 pt-5 mt-5 border-t border-[var(--c-border)]">
                <button
                  onClick={() => onClose()}
                  className="px-4 py-2 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] text-[var(--c-text-primary)] rounded-xl text-sm font-bold transition-all"
                >
                  Close
                </button>
                <button
                  onClick={disconnect}
                  className="px-4 py-2 bg-[var(--c-danger)]/10 hover:bg-[var(--c-danger)]/20 border border-[var(--c-danger)]/20 text-[var(--c-danger)] rounded-xl text-sm font-bold transition-all"
                >
                  Disconnect
                </button>
              </div>
            </>
          )}

          {/* Step: failed */}
          {step === 'failed' && (
            <>
              <div className="bg-[var(--c-danger)]/5 border border-[var(--c-danger)]/20 rounded-xl p-4 text-sm text-[var(--c-danger)] font-medium mb-3">
                {detail || 'Could not connect directly.'}
              </div>
              <p className="text-sm text-[var(--c-text-secondary)] leading-relaxed">
                Direct connections fail on strict networks (e.g. mobile / CGNAT). Ask your host to share a Radmin VPN address instead.
              </p>
              <div className="flex justify-end gap-3 pt-5 mt-5 border-t border-[var(--c-border)]">
                <button
                  onClick={close}
                  className="px-4 py-2 bg-[var(--c-base)] hover:bg-[var(--c-border)] border border-[var(--c-border)] text-[var(--c-text-primary)] rounded-xl text-sm font-bold transition-all"
                >
                  Close
                </button>
                <button
                  onClick={reset}
                  className="px-4 py-2 bg-[#00AF5C] hover:bg-[#00964F] text-white rounded-xl text-sm font-bold transition-all"
                >
                  Try again
                </button>
              </div>
            </>
          )}
        </motion.div>
      </motion.div>
    </ModalPortal>
  );
}
