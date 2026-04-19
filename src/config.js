import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'subagent-cli');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const RUNS_DIR = path.join(CONFIG_DIR, 'runs');

export function getConfigPath() {
  return CONFIG_PATH;
}

export function getRunsDir() {
  return RUNS_DIR;
}

export async function ensureConfigDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.mkdir(RUNS_DIR, { recursive: true, mode: 0o700 });
}

export async function loadRawConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function loadConfig() {
  const raw = await loadRawConfig();
  return raw ? normalizeConfig(raw) : null;
}

export async function saveConfig(config) {
  await ensureConfigDir();
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600
  });
  await fs.chmod(CONFIG_PATH, 0o600);
}

export function makeDefaultConfig() {
  return normalizeConfig({
    defaultAgent: 'codex',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agents: {
      codex: {
        kind: 'local',
        label: 'Codex',
        enabled: true,
        command: 'codex',
        args: ['exec', '--skip-git-repo-check'],
        promptMode: 'argv',
        description: 'Best default for repo-aware implementation, edits, and execution-heavy work.',
        roles: ['implementer'],
        capabilities: ['code', 'repo-edits', 'shell']
      },
      claude: {
        kind: 'local',
        label: 'Claude Code',
        enabled: true,
        command: 'claude',
        args: ['-p'],
        promptMode: 'argv',
        description: 'Strong for review, long-form reasoning, planning, and second opinions.',
        roles: ['reviewer', 'planner'],
        capabilities: ['review', 'planning', 'reasoning']
      },
      gemini: {
        kind: 'local',
        label: 'Gemini',
        enabled: true,
        command: 'gemini',
        args: ['-p'],
        promptMode: 'argv',
        description: 'Good for ideation, broad exploration, and parallel brainstorming.',
        roles: ['researcher', 'ideator'],
        capabilities: ['research', 'brainstorming', 'comparison']
      },
      ollama: {
        kind: 'local',
        label: 'Ollama',
        enabled: true,
        command: 'ollama',
        args: ['run', 'llama3.2'],
        promptMode: 'argv',
        description: 'Best for cheap/local/private background work and lightweight drafts.',
        roles: ['local-worker'],
        capabilities: ['local', 'private', 'low-cost']
      },
      antigravity: {
        kind: 'local',
        label: 'Antigravity',
        enabled: false,
        command: 'antigravity',
        args: [],
        promptMode: 'argv',
        description: 'Reserved for your remote/orchestration path once configured locally.',
        roles: ['orchestrator'],
        capabilities: ['orchestration']
      }
    },
    routing: {
      preferLocal: true,
      fallbackOrder: ['codex', 'claude', 'gemini'],
      defaultRemoteTransport: 'webhook'
    },
    analytics: {
      runs: [],
      byAgent: {}
    }
  });
}

export function normalizeConfig(config) {
  const normalized = {
    defaultAgent: config?.defaultAgent || 'codex',
    createdAt: config?.createdAt || new Date().toISOString(),
    updatedAt: config?.updatedAt || new Date().toISOString(),
    agents: {},
    routing: {
      preferLocal: config?.routing?.preferLocal ?? true,
      fallbackOrder: config?.routing?.fallbackOrder || ['codex', 'claude', 'gemini'],
      defaultRemoteTransport: config?.routing?.defaultRemoteTransport || 'webhook'
    },
    analytics: {
      runs: config?.analytics?.runs || [],
      byAgent: config?.analytics?.byAgent || {}
    }
  };

  for (const [name, agent] of Object.entries(config?.agents || {})) {
    normalized.agents[name] = normalizeAgent(agent);
  }

  return normalized;
}

export function normalizeAgent(agent) {
  const kind = agent?.kind || 'local';
  const normalized = {
    kind,
    label: agent?.label || 'Unnamed agent',
    enabled: agent?.enabled ?? true,
    description: agent?.description || '',
    roles: Array.isArray(agent?.roles) ? agent.roles : [],
    capabilities: Array.isArray(agent?.capabilities) ? agent.capabilities : [],
    labels: agent?.labels && typeof agent.labels === 'object' ? agent.labels : {}
  };

  if (kind === 'local') {
    normalized.command = agent?.command || '';
    normalized.args = Array.isArray(agent?.args) ? agent.args : [];
    normalized.promptMode = agent?.promptMode || 'argv';
  }

  if (kind === 'remote') {
    normalized.transport = agent?.transport && typeof agent.transport === 'object' ? agent.transport : null;
    normalized.auth = agent?.auth && typeof agent.auth === 'object' ? agent.auth : null;
  }

  return normalized;
}

export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object.'], warnings };
  }

  if (!config.defaultAgent) {
    errors.push('defaultAgent is required.');
  }

  if (!config.agents || typeof config.agents !== 'object' || Object.keys(config.agents).length === 0) {
    errors.push('agents must contain at least one agent definition.');
  }

  for (const [name, agent] of Object.entries(config.agents || {})) {
    if (!agent.kind) {
      warnings.push(`agents.${name}.kind missing, defaulting to local.`);
    }

    if (agent.kind === 'local') {
      if (!agent.command) errors.push(`agents.${name}.command is required for local agents.`);
      if (agent.promptMode && agent.promptMode !== 'argv') {
        errors.push(`agents.${name}.promptMode=${agent.promptMode} is unsupported.`);
      }
    }

    if (agent.kind === 'remote') {
      if (!agent.transport || typeof agent.transport !== 'object') {
        errors.push(`agents.${name}.transport is required for remote agents.`);
      } else {
        if (!agent.transport.type) errors.push(`agents.${name}.transport.type is required.`);
        if (agent.transport.type === 'webhook' && !agent.transport.endpoint) {
          errors.push(`agents.${name}.transport.endpoint is required for webhook agents.`);
        }
        if (agent.transport.type === 'ssh' && !agent.transport.host) {
          errors.push(`agents.${name}.transport.host is required for ssh agents.`);
        }
        if (agent.transport.type && !['webhook', 'ssh'].includes(agent.transport.type)) {
          errors.push(`agents.${name}.transport.type=${agent.transport.type} is unsupported.`);
        }
      }
    }

    if (agent.auth && !agent.auth.type) {
      errors.push(`agents.${name}.auth.type is required when auth is present.`);
    }
  }

  if (config.defaultAgent && config.agents && !config.agents[config.defaultAgent]) {
    errors.push(`defaultAgent references unknown agent: ${config.defaultAgent}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
