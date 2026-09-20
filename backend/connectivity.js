// Is the machine actually able to reach the services MineDash needs?
//
// The renderer can't answer this itself: `navigator.onLine` only says a network
// interface exists, so a laptop on hotel wifi with no route to the internet
// still reports "online" and every Modrinth panel fills with "Failed to fetch".
// The backend is where the real requests happen, so it decides.
//
// Two inputs:
//   1. A periodic probe of the upstream APIs we proxy.
//   2. Failures reported by the proxy routes themselves (noteUpstreamFailure),
//      so a dead connection is noticed on the first failed request instead of
//      up to a probe interval later.

const dns = require('dns').promises;

// Probing DNS rather than fetching a page: it's the cheapest signal that
// actually exercises the network, costs no bandwidth on metered connections,
// and doesn't hammer Modrinth every interval.
const PROBE_HOSTS = ['api.modrinth.com', 'hangar.papermc.io', 'piston-meta.mojang.com'];

const ONLINE_INTERVAL_MS = 60_000;   // steady state — just confirming we're still up
const OFFLINE_INTERVAL_MS = 10_000;  // offline — check back often so the UI restores quickly

let state = {
  online: true,        // optimistic until the first probe answers
  checkedAt: 0,
};
// The in-flight probe, if any. Callers arriving mid-probe wait for that result
// rather than reading stale state — `GET /api/connectivity?recheck=1` has to
// answer with a fresh verdict, and it's usually racing the periodic probe.
let inFlight = null;
let emit = () => {};
let timer = null;

async function probeOnce() {
  // One host answering is enough — a single provider being down isn't "offline".
  const results = await Promise.allSettled(
    PROBE_HOSTS.map(h => dns.lookup(h, { family: 4 }))
  );
  return results.some(r => r.status === 'fulfilled');
}

function setOnline(next) {
  const changed = state.online !== next;
  state = { ...state, online: next, checkedAt: Date.now() };
  if (changed) {
    console.log(`[connectivity] now ${next ? 'ONLINE' : 'OFFLINE'}`);
    emit('network_status', { online: next, checkedAt: state.checkedAt });
    schedule(); // flip to the other cadence
  }
  return changed;
}

function check() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const online = await probeOnce();
      setOnline(online);
      return online;
    } catch (_) {
      return state.online;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => { check().catch(() => {}); },
    state.online ? ONLINE_INTERVAL_MS : OFFLINE_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

/**
 * Called by proxy routes when an upstream request fails. Only network-level
 * errors count — a 404 or a 500 from Modrinth means we reached it just fine.
 */
function noteUpstreamFailure(err) {
  const code = err && (err.code || err.cause?.code || '');
  const msg = String((err && err.message) || '');
  const isNetwork =
    ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT'].includes(code) ||
    /fetch failed|getaddrinfo|network|socket hang up/i.test(msg);
  if (!isNetwork) return;
  // Confirm with a probe rather than trusting one failed request — a single
  // flaky call shouldn't blank the UI's browse tabs.
  check().catch(() => {});
}

/** Upstream call succeeded — we're demonstrably online, no probe needed. */
function noteUpstreamSuccess() {
  if (!state.online) setOnline(true);
}

function init(emitter) {
  emit = typeof emitter === 'function' ? emitter : () => {};
  check().catch(() => {});
  schedule();
}

const isOnline = () => state.online;
const getStatus = () => ({ online: state.online, checkedAt: state.checkedAt });

module.exports = { init, check, isOnline, getStatus, noteUpstreamFailure, noteUpstreamSuccess };
