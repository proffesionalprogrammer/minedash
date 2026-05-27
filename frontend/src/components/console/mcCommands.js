// ─── Command tree ──────────────────────────────────────────────────────────────
// Recursive completion data for vanilla Minecraft commands.
//
// Each node:
//   • Top-level: { cmd, desc, args? }   — `cmd` so the search filter is consistent.
//   • Nested:    { name, desc, args? }  — `name` for sub-arguments.
//
// `args` is the next level of completions. Omit when the argument is free-form
// (a player name, a coordinate, etc.) — the suggestion tree just stops there.
//
// Adding a new command: append to MC_COMMANDS in alphabetical order so the
// /help-style completion list reads naturally. Adding a sub-arg: nest under the
// parent's `args`.
export const MC_COMMANDS = [
  { cmd: 'advancement', desc: 'Manage player advancements', args: [
    { name: 'grant', desc: 'Grant advancements', args: [
      { name: 'everything', desc: 'Grant every advancement' },
      { name: 'only', desc: 'Grant a specific advancement' },
      { name: 'from', desc: 'Grant from an advancement forward' },
      { name: 'through', desc: 'Grant including parent chain' },
      { name: 'until', desc: 'Grant up to an advancement' },
    ]},
    { name: 'revoke', desc: 'Revoke advancements', args: [
      { name: 'everything', desc: 'Revoke every advancement' },
      { name: 'only', desc: 'Revoke a specific advancement' },
      { name: 'from', desc: 'Revoke from an advancement forward' },
      { name: 'through', desc: 'Revoke including parent chain' },
      { name: 'until', desc: 'Revoke up to an advancement' },
    ]},
  ]},
  { cmd: 'attribute', desc: 'Modify entity attributes', args: [
    { name: 'get', desc: 'Get an attribute value' },
    { name: 'base', desc: 'Manage base attribute value', args: [
      { name: 'get', desc: 'Get base value' },
      { name: 'set', desc: 'Set base value' },
    ]},
    { name: 'modifier', desc: 'Manage attribute modifiers', args: [
      { name: 'add', desc: 'Add a modifier' },
      { name: 'remove', desc: 'Remove a modifier' },
      { name: 'value', desc: 'Get modifier value', args: [
        { name: 'get', desc: 'Get the modifier value' },
      ]},
    ]},
  ]},
  { cmd: 'ban', desc: 'Ban a player from the server' },
  { cmd: 'ban-ip', desc: 'Ban an IP address' },
  { cmd: 'banlist', desc: 'Display the ban list', args: [
    { name: 'ips', desc: 'List banned IP addresses' },
    { name: 'players', desc: 'List banned players' },
  ]},
  { cmd: 'bossbar', desc: 'Manage boss bars', args: [
    { name: 'add', desc: 'Create a new boss bar' },
    { name: 'get', desc: 'Get boss bar info', args: [
      { name: 'color', desc: 'Get bar color' },
      { name: 'max', desc: 'Get max value' },
      { name: 'players', desc: 'Get visible players' },
      { name: 'style', desc: 'Get bar style' },
      { name: 'value', desc: 'Get current value' },
      { name: 'visible', desc: 'Get visibility state' },
    ]},
    { name: 'list', desc: 'List all boss bars' },
    { name: 'remove', desc: 'Remove a boss bar' },
    { name: 'set', desc: 'Modify a boss bar', args: [
      { name: 'color', desc: 'Set bar color' },
      { name: 'max', desc: 'Set max value' },
      { name: 'name', desc: 'Set display name' },
      { name: 'players', desc: 'Set visible players' },
      { name: 'style', desc: 'Set bar style' },
      { name: 'value', desc: 'Set current value' },
      { name: 'visible', desc: 'Set visibility state' },
    ]},
  ]},
  { cmd: 'clear', desc: 'Clear items from a player inventory' },
  { cmd: 'clone', desc: 'Copy blocks from one region to another' },
  { cmd: 'data', desc: 'Inspect or modify NBT data', args: [
    { name: 'get', desc: 'Get data from an entity or block' },
    { name: 'merge', desc: 'Merge data into an entity or block' },
    { name: 'modify', desc: 'Modify data on an entity or block' },
    { name: 'remove', desc: 'Remove data from an entity or block' },
  ]},
  { cmd: 'datapack', desc: 'Manage data packs', args: [
    { name: 'enable', desc: 'Enable a data pack' },
    { name: 'disable', desc: 'Disable a data pack' },
    { name: 'list', desc: 'List all data packs', args: [
      { name: 'available', desc: 'List available packs' },
      { name: 'enabled', desc: 'List enabled packs' },
    ]},
  ]},
  { cmd: 'debug', desc: 'Control the debug profiler', args: [
    { name: 'start', desc: 'Start a debug session' },
    { name: 'stop', desc: 'Stop a debug session' },
    { name: 'report', desc: 'Generate a debug report' },
  ]},
  { cmd: 'defaultgamemode', desc: 'Set the default game mode for new players', args: [
    { name: 'survival', desc: 'Survival mode' },
    { name: 'creative', desc: 'Creative mode' },
    { name: 'adventure', desc: 'Adventure mode' },
    { name: 'spectator', desc: 'Spectator mode' },
  ]},
  { cmd: 'deop', desc: 'Revoke operator status from a player' },
  { cmd: 'difficulty', desc: 'Set the server difficulty', args: [
    { name: 'peaceful', desc: 'Peaceful — no hostile mobs' },
    { name: 'easy', desc: 'Easy difficulty' },
    { name: 'normal', desc: 'Normal difficulty' },
    { name: 'hard', desc: 'Hard difficulty' },
  ]},
  { cmd: 'effect', desc: 'Apply or remove status effects', args: [
    { name: 'give', desc: 'Give a status effect to a player' },
    { name: 'clear', desc: 'Remove all effects from a player' },
  ]},
  { cmd: 'enchant', desc: "Enchant a player's held item" },
  { cmd: 'execute', desc: 'Run a command conditionally or as another entity', args: [
    { name: 'as', desc: 'Run as a specific entity' },
    { name: 'at', desc: 'Run at an entity\'s position' },
    { name: 'if', desc: 'Run if a condition is true', args: [
      { name: 'block', desc: 'If a block matches' },
      { name: 'blocks', desc: 'If block regions match' },
      { name: 'entity', desc: 'If entity exists' },
      { name: 'score', desc: 'If a score matches' },
      { name: 'predicate', desc: 'If a predicate passes' },
    ]},
    { name: 'unless', desc: 'Run unless a condition is true' },
    { name: 'in', desc: 'Run in a specific dimension' },
    { name: 'positioned', desc: 'Run at specific coordinates' },
    { name: 'rotated', desc: 'Run with a specific rotation' },
    { name: 'run', desc: 'Execute the following command' },
    { name: 'store', desc: 'Store the result of a command' },
    { name: 'align', desc: 'Align to block grid' },
    { name: 'anchored', desc: 'Offset to eyes or feet' },
    { name: 'facing', desc: 'Run facing a position or entity' },
  ]},
  { cmd: 'experience', desc: 'Add or set player experience', args: [
    { name: 'add', desc: 'Add experience to a player' },
    { name: 'set', desc: 'Set a player\'s experience' },
    { name: 'query', desc: 'Query a player\'s experience', args: [
      { name: 'levels', desc: 'Query experience levels' },
      { name: 'points', desc: 'Query experience points' },
    ]},
  ]},
  { cmd: 'fill', desc: 'Fill a region with a specific block', args: [
    { name: 'destroy', desc: 'Replace and drop as items' },
    { name: 'hollow', desc: 'Fill only the outer shell' },
    { name: 'keep', desc: 'Replace only air blocks' },
    { name: 'outline', desc: 'Outline only, leave interior' },
    { name: 'replace', desc: 'Replace a specific block type' },
  ]},
  { cmd: 'forceload', desc: 'Force chunks to stay loaded', args: [
    { name: 'add', desc: 'Force load a chunk range' },
    { name: 'remove', desc: 'Stop force loading chunks' },
    { name: 'query', desc: 'Query which chunks are force loaded' },
  ]},
  { cmd: 'function', desc: 'Run a data pack function' },
  { cmd: 'gamemode', desc: "Set a player's game mode", args: [
    { name: 'survival', desc: 'Survival mode (0)' },
    { name: 'creative', desc: 'Creative mode (1)' },
    { name: 'adventure', desc: 'Adventure mode (2)' },
    { name: 'spectator', desc: 'Spectator mode (3)' },
  ]},
  { cmd: 'gamerule', desc: 'Set or query a game rule', args: [
    { name: 'announceAdvancements', desc: 'Announce advancements in chat' },
    { name: 'commandBlockOutput', desc: 'Command block output in chat' },
    { name: 'disableElytraMovementCheck', desc: 'Disable elytra speed check' },
    { name: 'doDaylightCycle', desc: 'Toggle day/night cycle' },
    { name: 'doEntityDrops', desc: 'Toggle entity loot drops' },
    { name: 'doFireTick', desc: 'Toggle fire spreading' },
    { name: 'doInsomnia', desc: 'Toggle phantom spawning at night' },
    { name: 'doImmediateRespawn', desc: 'Skip respawn screen' },
    { name: 'doLimitedCrafting', desc: 'Require recipes to be unlocked' },
    { name: 'doMobLoot', desc: 'Toggle mob loot drops' },
    { name: 'doMobSpawning', desc: 'Toggle mob spawning' },
    { name: 'doPatrolSpawning', desc: 'Toggle patrol spawning' },
    { name: 'doTileDrops', desc: 'Toggle block item drops' },
    { name: 'doTraderSpawning', desc: 'Toggle wandering trader spawning' },
    { name: 'doWeatherCycle', desc: 'Toggle weather changes' },
    { name: 'drowningDamage', desc: 'Toggle drowning damage' },
    { name: 'fallDamage', desc: 'Toggle fall damage' },
    { name: 'fireDamage', desc: 'Toggle fire damage' },
    { name: 'forgiveDeadPlayers', desc: 'Toggle mobs forgetting players on death' },
    { name: 'freezeDamage', desc: 'Toggle freeze damage' },
    { name: 'keepInventory', desc: 'Keep inventory on death' },
    { name: 'logAdminCommands', desc: 'Log admin commands' },
    { name: 'maxCommandChainLength', desc: 'Max command chain length' },
    { name: 'maxEntityCramming', desc: 'Max entities in one block' },
    { name: 'mobGriefing', desc: 'Toggle mob block interactions' },
    { name: 'naturalRegeneration', desc: 'Toggle natural HP regeneration' },
    { name: 'playersSleepingPercentage', desc: 'Percent of players needed to sleep' },
    { name: 'pvp', desc: 'Toggle player vs player damage' },
    { name: 'randomTickSpeed', desc: 'Rate of random block ticks' },
    { name: 'reducedDebugInfo', desc: 'Reduce debug screen info' },
    { name: 'sendCommandFeedback', desc: 'Show command feedback to player' },
    { name: 'showDeathMessages', desc: 'Show death messages in chat' },
    { name: 'spawnRadius', desc: 'Block radius of the spawn area' },
    { name: 'spectatorsGenerateChunks', desc: 'Spectators load chunks' },
    { name: 'universalAnger', desc: 'Neutral mobs attack all players' },
  ]},
  { cmd: 'give', desc: 'Give items to a player' },
  { cmd: 'help', desc: 'Show help for a command' },
  { cmd: 'item', desc: 'Manipulate items in inventories', args: [
    { name: 'modify', desc: 'Modify an item' },
    { name: 'replace', desc: 'Replace an item', args: [
      { name: 'block', desc: 'Replace item in a block' },
      { name: 'entity', desc: 'Replace item on an entity' },
    ]},
  ]},
  { cmd: 'kick', desc: 'Kick a player from the server' },
  { cmd: 'kill', desc: 'Kill entities' },
  { cmd: 'list', desc: 'List online players', args: [
    { name: 'uuids', desc: 'Include player UUIDs in output' },
  ]},
  { cmd: 'locate', desc: 'Locate a nearby structure or biome', args: [
    { name: 'structure', desc: 'Find a nearby structure' },
    { name: 'biome', desc: 'Find a nearby biome' },
    { name: 'poi', desc: 'Find a nearby point of interest' },
  ]},
  { cmd: 'loot', desc: 'Drop loot from a loot table', args: [
    { name: 'spawn', desc: 'Spawn loot at a location' },
    { name: 'drop', desc: 'Drop loot at a player\'s feet' },
    { name: 'give', desc: 'Give loot to a player' },
    { name: 'insert', desc: 'Insert loot into a container' },
    { name: 'replace', desc: 'Replace items with loot' },
  ]},
  { cmd: 'me', desc: 'Display an action message in chat' },
  { cmd: 'msg', desc: 'Send a private message to a player' },
  { cmd: 'op', desc: 'Grant operator status to a player' },
  { cmd: 'pardon', desc: 'Remove a player ban' },
  { cmd: 'pardon-ip', desc: 'Remove an IP ban' },
  { cmd: 'particle', desc: 'Spawn particle effects at a location' },
  { cmd: 'perf', desc: 'Capture a performance profile', args: [
    { name: 'start', desc: 'Start performance profiling' },
    { name: 'stop', desc: 'Stop performance profiling' },
  ]},
  { cmd: 'place', desc: 'Place a structure or feature', args: [
    { name: 'feature', desc: 'Place a configured feature' },
    { name: 'jigsaw', desc: 'Place a jigsaw structure' },
    { name: 'structure', desc: 'Place a structure' },
    { name: 'template', desc: 'Place a structure template' },
  ]},
  { cmd: 'playsound', desc: 'Play a sound effect for a player' },
  { cmd: 'recipe', desc: 'Give or take crafting recipes from players', args: [
    { name: 'give', desc: 'Give a recipe to a player' },
    { name: 'take', desc: 'Take a recipe from a player' },
  ]},
  { cmd: 'reload', desc: 'Reload all data packs and resource packs' },
  { cmd: 'save-all', desc: 'Save the world to disk', args: [
    { name: 'flush', desc: 'Flush all pending writes immediately' },
  ]},
  { cmd: 'save-off', desc: 'Disable automatic world saving' },
  { cmd: 'save-on', desc: 'Enable automatic world saving' },
  { cmd: 'say', desc: 'Broadcast a message to all online players' },
  { cmd: 'schedule', desc: 'Schedule a function to run later', args: [
    { name: 'function', desc: 'Schedule a data pack function' },
    { name: 'clear', desc: 'Cancel a scheduled function' },
  ]},
  { cmd: 'scoreboard', desc: 'Manage scoreboard objectives and players', args: [
    { name: 'objectives', desc: 'Manage objectives', args: [
      { name: 'add', desc: 'Create a new objective' },
      { name: 'list', desc: 'List all objectives' },
      { name: 'modify', desc: 'Modify an objective property' },
      { name: 'remove', desc: 'Delete an objective' },
      { name: 'setdisplay', desc: 'Set the display slot' },
    ]},
    { name: 'players', desc: 'Manage player scores', args: [
      { name: 'add', desc: 'Add to a player score' },
      { name: 'enable', desc: 'Enable a trigger objective' },
      { name: 'get', desc: 'Get a player score' },
      { name: 'list', desc: 'List all player scores' },
      { name: 'operation', desc: 'Perform a math operation on scores' },
      { name: 'remove', desc: 'Subtract from a player score' },
      { name: 'reset', desc: 'Reset a player score' },
      { name: 'set', desc: 'Set a player score to a value' },
    ]},
  ]},
  { cmd: 'seed', desc: 'Display the world seed' },
  { cmd: 'setblock', desc: 'Place a block at a specific location', args: [
    { name: 'destroy', desc: 'Destroy and drop the old block' },
    { name: 'keep', desc: 'Only place if the target is air' },
    { name: 'replace', desc: 'Replace regardless of what is there' },
  ]},
  { cmd: 'setworldspawn', desc: 'Set the world spawn point' },
  { cmd: 'spawnpoint', desc: "Set a player's respawn point" },
  { cmd: 'spreadplayers', desc: 'Randomly spread players across an area' },
  { cmd: 'stop', desc: 'Stop the server gracefully' },
  { cmd: 'stopsound', desc: 'Stop a playing sound for a player' },
  { cmd: 'summon', desc: 'Summon an entity at a location' },
  { cmd: 'tag', desc: 'Manage entity tags', args: [
    { name: 'add', desc: 'Add a tag to matching entities' },
    { name: 'list', desc: 'List tags on matching entities' },
    { name: 'remove', desc: 'Remove a tag from matching entities' },
  ]},
  { cmd: 'team', desc: 'Manage scoreboard teams', args: [
    { name: 'add', desc: 'Create a new team' },
    { name: 'empty', desc: 'Remove all members from a team' },
    { name: 'join', desc: 'Add entities to a team' },
    { name: 'leave', desc: 'Remove entities from a team' },
    { name: 'list', desc: 'List all teams' },
    { name: 'modify', desc: 'Change a team option', args: [
      { name: 'color', desc: 'Set team color' },
      { name: 'displayName', desc: 'Set display name' },
      { name: 'friendlyFire', desc: 'Toggle friendly fire' },
      { name: 'seeFriendlyInvisibles', desc: 'See invisible teammates' },
      { name: 'nametagVisibility', desc: 'Control nametag visibility' },
      { name: 'deathMessageVisibility', desc: 'Control death message visibility' },
      { name: 'collisionRule', desc: 'Set collision rule' },
      { name: 'prefix', desc: 'Set player name prefix' },
      { name: 'suffix', desc: 'Set player name suffix' },
    ]},
    { name: 'remove', desc: 'Delete a team' },
  ]},
  { cmd: 'teleport', desc: 'Teleport an entity to a location or player' },
  { cmd: 'tell', desc: 'Send a private message to a player' },
  { cmd: 'tellraw', desc: 'Send a formatted JSON message to a player' },
  { cmd: 'time', desc: 'Change or query the world time', args: [
    { name: 'add', desc: 'Add ticks to the current time' },
    { name: 'query', desc: 'Query the current time', args: [
      { name: 'day', desc: 'Number of in-game days elapsed' },
      { name: 'daytime', desc: 'Ticks since the start of today' },
      { name: 'gametime', desc: 'Total ticks since world creation' },
    ]},
    { name: 'set', desc: 'Set the time to a specific value', args: [
      { name: 'day', desc: '1000 ticks — sunrise' },
      { name: 'noon', desc: '6000 ticks — midday' },
      { name: 'night', desc: '13000 ticks — nightfall' },
      { name: 'midnight', desc: '18000 ticks — midnight' },
    ]},
  ]},
  { cmd: 'title', desc: 'Display title text on a player\'s screen', args: [
    { name: 'actionbar', desc: 'Show an action bar message' },
    { name: 'clear', desc: 'Clear the displayed title' },
    { name: 'reset', desc: 'Reset title display settings' },
    { name: 'subtitle', desc: 'Set the subtitle text' },
    { name: 'times', desc: 'Set fade-in, display, and fade-out times' },
    { name: 'title', desc: 'Display the main title' },
  ]},
  { cmd: 'tp', desc: 'Teleport a player to a location or another player' },
  { cmd: 'trigger', desc: 'Set a trigger scoreboard objective value' },
  { cmd: 'weather', desc: 'Set the server weather', args: [
    { name: 'clear', desc: 'Clear sky — no rain or thunder' },
    { name: 'rain', desc: 'Rain weather' },
    { name: 'thunder', desc: 'Thunderstorm' },
  ]},
  { cmd: 'whitelist', desc: 'Manage the server whitelist', args: [
    { name: 'add', desc: 'Add a player to the whitelist' },
    { name: 'list', desc: 'List all whitelisted players' },
    { name: 'off', desc: 'Disable the whitelist' },
    { name: 'on', desc: 'Enable the whitelist' },
    { name: 'reload', desc: 'Reload the whitelist from disk' },
    { name: 'remove', desc: 'Remove a player from the whitelist' },
  ]},
  { cmd: 'worldborder', desc: 'Manage the world border', args: [
    { name: 'add', desc: 'Expand or shrink the border gradually' },
    { name: 'center', desc: 'Set the border center point' },
    { name: 'damage', desc: 'Configure border damage', args: [
      { name: 'amount', desc: 'Set damage per block per second' },
      { name: 'buffer', desc: 'Set the safe buffer distance' },
    ]},
    { name: 'get', desc: 'Get the current border diameter' },
    { name: 'set', desc: 'Set the border diameter (instantly or over time)' },
    { name: 'warning', desc: 'Configure border warning', args: [
      { name: 'distance', desc: 'Set warning block distance' },
      { name: 'time', desc: 'Set warning countdown in seconds' },
    ]},
  ]},
  { cmd: 'xp', desc: 'Shorthand for /experience' },
];

// ─── Autocomplete tree traversal ───────────────────────────────────────────────
// Returns suggestions for the current input. Each suggestion has:
//   { label, desc, isCommand, base }
// `base` is the part of the input to keep when the user selects this suggestion.
export function getSuggestions(input) {
  if (!input.trim()) return [];

  const hasTrailingSpace = /\s$/.test(input);
  const raw = input.startsWith('/') ? input.slice(1) : input;
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  // Completing the command name itself
  if (tokens.length === 1 && !hasTrailingSpace) {
    const q = tokens[0].toLowerCase();
    return MC_COMMANDS
      .filter(c => c.cmd.startsWith(q))
      .slice(0, 10)
      .map(c => ({
        label: c.cmd,
        desc: c.desc,
        isCommand: true,
        base: input.startsWith('/') ? '/' : '',
      }));
  }

  // Completing a sub-command / argument
  const cmdName = tokens[0].toLowerCase();
  const cmd = MC_COMMANDS.find(c => c.cmd === cmdName);
  if (!cmd?.args?.length) return [];

  // Navigate the tree for every already-completed argument token.
  // If trailing space: all tokens after cmd are "done".
  // If no trailing space: all tokens except the last are "done".
  const completedTokens = hasTrailingSpace ? tokens.slice(1) : tokens.slice(1, -1);
  let argList = cmd.args;

  for (const tok of completedTokens) {
    const found = argList?.find(a => a.name.toLowerCase() === tok.toLowerCase());
    argList = found?.args;
    if (!argList) return [];
  }

  if (!argList) return [];

  // The token currently being typed (empty string if trailing space)
  const currentTok = hasTrailingSpace ? '' : tokens[tokens.length - 1].toLowerCase();

  // Base = everything to keep in the input before appending the new token
  const base = hasTrailingSpace
    ? input
    : input.slice(0, input.length - tokens[tokens.length - 1].length);

  return argList
    .filter(a => a.name.toLowerCase().startsWith(currentTok))
    .slice(0, 10)
    .map(a => ({ label: a.name, desc: a.desc, isCommand: false, base }));
}
