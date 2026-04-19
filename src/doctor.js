import { getConfigPath, loadConfig, loadRawConfig, saveConfig, validateConfig } from './config.js';

const RESERVED_TOP_LEVEL_KEYS = new Set([
  'defaultAgent',
  'createdAt',
  'updatedAt',
  'agents',
  'routing',
  'analytics'
]);

export async function inspectConfigDoctor() {
  const rawConfig = await loadRawConfig();
  if (!rawConfig) {
    return {
      ok: false,
      configPath: getConfigPath(),
      errors: ['Config file not found. Run `subagent config init` first.'],
      warnings: [],
      fixesAvailable: [],
      changes: []
    };
  }

  const raw = structuredClone(rawConfig);
  const normalized = await loadConfig();
  const misplacedAgents = findMisplacedAgents(raw);
  const validation = validateConfig(normalized);

  const warnings = [...validation.warnings];
  if (misplacedAgents.length > 0) {
    warnings.push(
      `Found ${misplacedAgents.length} misplaced top-level agent entr${misplacedAgents.length === 1 ? 'y' : 'ies'} outside config.agents.`
    );
  }

  return {
    ok: validation.valid && misplacedAgents.length === 0,
    configPath: getConfigPath(),
    errors: validation.errors,
    warnings,
    fixesAvailable:
      misplacedAgents.length > 0
        ? [
            {
              id: 'move-misplaced-agents',
              description: 'Move misplaced top-level agent entries into config.agents.'
            }
          ]
        : [],
    changes: [],
    misplacedAgents: misplacedAgents.map(({ name, reason }) => ({ name, reason }))
  };
}

export async function doctorFixConfig() {
  const rawConfig = await loadRawConfig();
  if (!rawConfig) {
    return {
      ok: false,
      configPath: getConfigPath(),
      errors: ['Config file not found. Run `subagent config init` first.'],
      warnings: [],
      fixesApplied: [],
      changes: []
    };
  }

  const raw = structuredClone(rawConfig);
  const misplacedAgents = findMisplacedAgents(raw);
  const fixesApplied = [];
  const changes = [];

  if (misplacedAgents.length > 0) {
    raw.agents ||= {};

    for (const { name, agent } of misplacedAgents) {
      raw.agents[name] = agent;
      delete raw[name];
      changes.push({
        type: 'moved-agent',
        agent: name,
        from: `top-level:${name}`,
        to: `agents.${name}`
      });
    }

    fixesApplied.push({
      id: 'move-misplaced-agents',
      count: misplacedAgents.length
    });
  }

  raw.updatedAt = new Date().toISOString();
  await saveConfig(raw);

  const repaired = await inspectConfigDoctor();
  return {
    ok: repaired.errors.length === 0,
    configPath: getConfigPath(),
    errors: repaired.errors,
    warnings: repaired.warnings,
    fixesApplied,
    changes,
    postFix: repaired
  };
}

function findMisplacedAgents(config) {
  const entries = [];

  for (const [name, value] of Object.entries(config || {})) {
    if (RESERVED_TOP_LEVEL_KEYS.has(name)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (!looksLikeAgent(value)) continue;

    entries.push({
      name,
      agent: value,
      reason: 'top-level object looks like an agent definition'
    });
  }

  return entries;
}

function looksLikeAgent(value) {
  if (typeof value !== 'object' || !value) return false;
  if (typeof value.kind !== 'string') return false;
  if (!['local', 'remote'].includes(value.kind)) return false;

  if (value.kind === 'local') {
    return typeof value.command === 'string' || Array.isArray(value.args) || typeof value.promptMode === 'string';
  }

  if (value.kind === 'remote') {
    return Boolean(value.transport && typeof value.transport === 'object');
  }

  return false;
}
