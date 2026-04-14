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

export async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveConfig(config) {
  await ensureConfigDir();
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600
  });
  await fs.chmod(CONFIG_PATH, 0o600);
}

export function makeDefaultConfig() {
  return {
    defaultAgent: 'codex',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agents: {
      codex: {
        label: 'Codex',
        enabled: true,
        command: 'codex',
        args: ['exec', '--skip-git-repo-check'],
        promptMode: 'argv',
        description: 'Best default for repo-aware implementation, edits, and execution-heavy work.'
      },
      claude: {
        label: 'Claude Code',
        enabled: true,
        command: 'claude',
        args: ['-p'],
        promptMode: 'argv',
        description: 'Strong for review, long-form reasoning, planning, and second opinions.'
      },
      gemini: {
        label: 'Gemini',
        enabled: true,
        command: 'gemini',
        args: ['-p'],
        promptMode: 'argv',
        description: 'Good for ideation, broad exploration, and parallel brainstorming.'
      },
      ollama: {
        label: 'Ollama',
        enabled: true,
        command: 'ollama',
        args: ['run', 'llama3.2'],
        promptMode: 'argv',
        description: 'Best for cheap/local/private background work and lightweight drafts.'
      },
      antigravity: {
        label: 'Antigravity',
        enabled: false,
        command: 'antigravity',
        args: [],
        promptMode: 'argv',
        description: 'Reserved for your remote/orchestration path once configured locally.'
      }
    },
    analytics: {
      runs: [],
      byAgent: {}
    }
  };
}
