// Launch-args snapshot test.
//
// mclc's launch args are positional and fragile, and a stray `-javaagent`
// silently breaks a premium / Microsoft launch (risk callout #1). This harness
// pins the deterministic part of the launch builder — the authlib-injector JVM
// args we inject for an offline account with Ely.by skins — to a snapshot, and
// exercises the agent-arg gate. Run it after any change to the launch builder;
// a diff means launch behaviour changed and you should confirm it was intended.
//
//   node backend/test/launch-args.test.js            # check against snapshot
//   node backend/test/launch-args.test.js --update    # rewrite the snapshot
//
// No test framework — plain asserts, exit code 0 = pass, non-zero = fail.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  buildElyByAgentArgs,
  assertAgentArgsGate,
  hyphenateUuid,
} = require('../launcher');

const SNAPSHOT_PATH = path.join(__dirname, 'launch-args.snapshot.json');
const update = process.argv.includes('--update');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

// ── Deterministic fixtures (no randomness — that's the point of a snapshot) ──
// Forward-slash path so the snapshot is identical across Windows / *nix.
const elybyLaunch = {
  jarPath: '/data/MineDash/authlib-injector/authlib-injector.jar',
  prefetchB64: 'UFJFRkVUQ0hfTUVUQURBVEE=',
  profileUuid: hyphenateUuid('ffb3378cd561502fa78a08494be68811'),
};

const actual = {
  offlineWithElyBySkins: {
    customArgs: buildElyByAgentArgs(elybyLaunch),
  },
};

// ── Snapshot ────────────────────────────────────────────────────────────────
console.log('Launch-args snapshot:');
if (update || !fs.existsSync(SNAPSHOT_PATH)) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(actual, null, 2) + '\n');
  console.log(`  ${update ? 'updated' : 'created'} ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
} else {
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  check('matches snapshot', () => {
    assert.deepStrictEqual(actual, expected,
      'Launch args changed vs snapshot. If intentional, re-run with --update.\n' +
      `       expected: ${JSON.stringify(expected.offlineWithElyBySkins.customArgs)}\n` +
      `       actual:   ${JSON.stringify(actual.offlineWithElyBySkins.customArgs)}`);
  });
}

// ── Agent args shape ──────────────────────────────────────────────────────────
console.log('Ely.by agent args:');
const agentArgs = buildElyByAgentArgs(elybyLaunch);
check('javaagent points at the resolved jar with =ely.by', () =>
  assert.strictEqual(agentArgs[0], `-javaagent:${elybyLaunch.jarPath}=ely.by`));
check('includes prefetched metadata', () =>
  assert.ok(agentArgs.some(a => a === `-Dauthlibinjector.yggdrasil.prefetched=${elybyLaunch.prefetchB64}`)));
check('includes noShowServerName', () =>
  assert.ok(agentArgs.includes('-Dauthlibinjector.noShowServerName')));
check('hyphenates the Ely.by UUID', () =>
  assert.strictEqual(elybyLaunch.profileUuid, 'ffb3378c-d561-502f-a78a-08494be68811'));

// ── The gate: agent present iff we intended it (expectAgent) ──────────────────
console.log('Agent-arg gate:');
const neoForgeArgs = ['-p', '/libs/modulepath', '--add-opens', 'java.base/java.util=ALL-UNNAMED'];
check('no skins + no agent → ok',          () => assertAgentArgsGate(false, []));
check('no skins + neoforge args → ok',      () => assertAgentArgsGate(false, neoForgeArgs));
check('skins + agent → ok',                 () => assertAgentArgsGate(true, agentArgs));
check('skins + agent + neoforge → ok',      () => assertAgentArgsGate(true, [...agentArgs, ...neoForgeArgs]));
check('no skins + stray agent → THROWS',    () => assert.throws(() => assertAgentArgsGate(false, agentArgs)));
check('no skins + neoforge+agent → THROWS', () => assert.throws(() => assertAgentArgsGate(false, [...neoForgeArgs, ...agentArgs])));
check('skins + missing agent → THROWS',     () => assert.throws(() => assertAgentArgsGate(true, neoForgeArgs)));

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
