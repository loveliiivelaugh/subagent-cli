import {
  ensureConfigDir,
  getConfigPath,
  loadConfig,
  makeDefaultConfig,
  saveConfig,
  validateConfig
} from './config.js';
import { runAgent, runBatch } from './executor.js';
import { routeTask } from './router.js';

export async function runCli(argv) {
  const { flags, positionals } = parseArgs(argv);
  const command = positionals[0];

  if (!command || flags.help) {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case 'config':
        await cmdConfig(positionals.slice(1), flags);
        return;
      case 'agents':
        await cmdAgents(flags);
        return;
      case 'info':
        await cmdInfo(positionals.slice(1), flags);
        return;
      case 'route':
        await cmdRoute(positionals.slice(1), flags);
        return;
      case 'run':
        await cmdRun(positionals.slice(1), flags);
        return;
      case 'batch':
        await cmdBatch(positionals.slice(1), flags);
        return;
      case 'stats':
        await cmdStats(flags);
        return;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

async function cmdConfig(args, flags) {
  const action = args[0];

  if (!action || action === 'path') {
    console.log(getConfigPath());
    return;
  }

  if (action === 'init') {
    const existing = await loadConfig();
    if (existing && !toBoolean(flags.force, false)) {
      throw new Error('Config already exists. Re-run with --force to overwrite it.');
    }

    const config = makeDefaultConfig();
    await saveConfig(config);
    console.log(`Wrote config to ${getConfigPath()}`);
    return;
  }

  if (action === 'set-default') {
    const agent = String(args[1] || '').trim();
    if (!agent) {
      throw new Error('Usage: subagent config set-default <agent>');
    }

    const config = await loadOrInitConfig();
    if (!config.agents[agent]) {
      throw new Error(`Unknown agent: ${agent}`);
    }

    config.defaultAgent = agent;
    config.updatedAt = new Date().toISOString();
    await saveConfig(config);
    console.log(`Default agent set to ${agent}`);
    return;
  }

  if (action === 'validate') {
    const config = await loadOrInitConfig();
    const report = validateConfig(config);
    printResult(
      {
        configPath: getConfigPath(),
        ...report
      },
      flags
    );

    if (!report.valid) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error('Usage: subagent config <path|init|set-default|validate>');
}

async function cmdAgents(flags) {
  const config = await loadOrInitConfig();
  const data = Object.entries(config.agents).map(([name, agent]) => ({
    name,
    kind: agent.kind || 'local',
    enabled: agent.enabled,
    command: agent.command,
    args: agent.args,
    transport: agent.transport
      ? {
          type: agent.transport.type,
          endpoint: agent.transport.endpoint
        }
      : undefined,
    roles: agent.roles || [],
    capabilities: agent.capabilities || [],
    description: agent.description
  }));

  printResult(
    {
      defaultAgent: config.defaultAgent,
      agents: data
    },
    flags
  );
}

async function cmdInfo(args, flags) {
  const name = String(args[0] || '').trim();
  if (!name) {
    throw new Error('Usage: subagent info <agent>');
  }

  const config = await loadOrInitConfig();
  const agent = config.agents[name];
  if (!agent) {
    throw new Error(`Unknown agent: ${name}`);
  }

  printResult(
    {
      name,
      defaultAgent: config.defaultAgent,
      agent: redactSecrets(agent)
    },
    flags
  );
}

async function cmdRoute(args, flags) {
  const task = args.join(' ').trim();
  if (!task) {
    throw new Error('Usage: subagent route "<task>" [--code] [--review] [--plan] [--research] [--private]');
  }

  const config = await loadOrInitConfig();
  const forcedAgent = String(flags.agent || '').trim();
  const result = routeTask({
    task,
    config,
    flags: {
      ...flags,
      agent: forcedAgent || undefined
    }
  });

  printResult(
    {
      task,
      selected: result.selected,
      matchedSignals: result.matchedSignals,
      candidates: result.candidates
    },
    flags
  );
}

async function cmdRun(args, flags) {
  const task = args.join(' ').trim();
  if (!task) {
    throw new Error('Usage: subagent run "<task>" [--agent <name>] [--cwd <dir>] [--background] [--dry-run]');
  }

  const config = await loadOrInitConfig();
  const selectedAgent = resolveRunAgent({ config, task, flags });
  const agentConfig = config.agents[selectedAgent];
  if (!agentConfig?.enabled) {
    throw new Error(`Agent not enabled: ${selectedAgent}`);
  }

  const execution = await runAgent({
    agentName: selectedAgent,
    agentConfig,
    task,
    cwd: flags.cwd ? String(flags.cwd) : undefined,
    background: toBoolean(flags.background, false),
    dryRun: toBoolean(flags['dry-run'], false)
  });

  if (!execution.dryRun) {
    await trackRun(config, {
      task,
      agent: selectedAgent,
      success: execution.ok,
      background: Boolean(execution.background),
      dryRun: false
    });
  }

  printResult(
    {
      task,
      selectedAgent,
      execution
    },
    flags
  );
}

async function cmdBatch(args, flags) {
  const task = args.join(' ').trim();
  if (!task) {
    throw new Error('Usage: subagent batch "<task>" --agent codex --agent claude [--cwd <dir>] [--background]');
  }

  const config = await loadOrInitConfig();
  const explicitAgents = arrayFlag(flags.agent);
  const topCount = explicitAgents.length === 0 ? numberFlag(flags.top ?? 2, '--top') : explicitAgents.length;
  const chosenAgents =
    explicitAgents.length > 0
      ? explicitAgents
      : routeTask({ task, config, flags: { ...flags, parallel: true } }).candidates.slice(0, topCount).map((item) => item.name);

  const tasks = chosenAgents.map((agentName) => {
    const agentConfig = config.agents[agentName];
    if (!agentConfig?.enabled) {
      throw new Error(`Agent not enabled: ${agentName}`);
    }

    return {
      agentName,
      agentConfig,
      task,
      cwd: flags.cwd ? String(flags.cwd) : undefined,
      background: toBoolean(flags.background, false),
      dryRun: toBoolean(flags['dry-run'], false)
    };
  });

  const results = await runBatch({ tasks });

  for (const result of results) {
    if (!result.dryRun) {
      await trackRun(config, {
        task,
        agent: result.agent,
        success: result.ok,
        background: Boolean(result.background),
        dryRun: false
      });
    }
  }

  printResult(
    {
      task,
      agents: chosenAgents,
      results
    },
    flags
  );
}

async function cmdStats(flags) {
  const config = await loadOrInitConfig();
  const runs = config.analytics?.runs || [];
  const byAgent = Object.entries(config.analytics?.byAgent || {})
    .map(([agent, stats]) => ({
      agent,
      runs: stats.runs || 0,
      successes: stats.successes || 0,
      backgroundRuns: stats.backgroundRuns || 0,
      lastRunAt: stats.lastRunAt || null
    }))
    .sort((a, b) => b.runs - a.runs || a.agent.localeCompare(b.agent));

  printResult(
    {
      configPath: getConfigPath(),
      totalRuns: runs.length,
      byAgent,
      recentRuns: runs.slice(-10).reverse()
    },
    flags
  );
}

function resolveRunAgent({ config, task, flags }) {
  const explicit = String(flags.agent || '').trim();
  if (explicit) return explicit;

  const routed = routeTask({ task, config, flags });
  return routed.selected?.name || config.defaultAgent;
}

async function loadOrInitConfig() {
  let config = await loadConfig();
  if (config) return config;

  config = makeDefaultConfig();
  await ensureConfigDir();
  await saveConfig(config);
  return config;
}

async function trackRun(config, run) {
  const timestampedRun = {
    ...run,
    ranAt: new Date().toISOString()
  };

  config.analytics ||= { runs: [], byAgent: {} };
  config.analytics.runs ||= [];
  config.analytics.byAgent ||= {};
  config.analytics.runs.push(timestampedRun);
  config.analytics.runs = config.analytics.runs.slice(-200);

  const stats = (config.analytics.byAgent[run.agent] ||= {
    runs: 0,
    successes: 0,
    backgroundRuns: 0,
    lastRunAt: null
  });

  stats.runs += 1;
  if (run.success) stats.successes += 1;
  if (run.background) stats.backgroundRuns += 1;
  stats.lastRunAt = timestampedRun.ranAt;

  config.updatedAt = timestampedRun.ranAt;
  await saveConfig(config);
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const raw = token.slice(2);
      const eqIndex = raw.indexOf('=');
      const key = eqIndex === -1 ? raw : raw.slice(0, eqIndex);
      const inlineValue = eqIndex === -1 ? undefined : raw.slice(eqIndex + 1);
      const next = argv[index + 1];
      const canConsume = inlineValue === undefined && next && !next.startsWith('-');
      const value = inlineValue ?? (canConsume ? next : true);
      assignFlag(flags, key, value);
      if (canConsume) index += 1;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1);
      if (short === 'h') {
        flags.help = true;
        continue;
      }

      throw new Error(`Unknown short flag: ${token}`);
    }

    positionals.push(token);
  }

  return { flags, positionals };
}

function assignFlag(flags, key, value) {
  if (flags[key] === undefined) {
    flags[key] = value;
    return;
  }

  if (Array.isArray(flags[key])) {
    flags[key].push(value);
    return;
  }

  flags[key] = [flags[key], value];
}

function arrayFlag(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function numberFlag(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${label}: ${value}`);
  }
  return parsed;
}

function toBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function printResult(result, flags) {
  if (toBoolean(flags.json, true)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(result);
}

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    if (['secret', 'token', 'password', 'apiKey'].includes(key)) {
      redacted[key] = '[redacted]';
      continue;
    }

    redacted[key] = redactSecrets(entry);
  }

  return redacted;
}

function printHelp() {
  console.log(`subagent-cli

Route work to local agent CLIs using simple policy, local analytics, and optional fan-out.

Usage:
  subagent config init [--force]
  subagent config path
  subagent config set-default <agent>
  subagent config validate
  subagent agents [--json false]
  subagent info <agent> [--json false]
  subagent route "<task>" [--code] [--review] [--plan] [--research] [--private] [--background]
  subagent run "<task>" [--agent <name>] [--cwd <dir>] [--background] [--dry-run]
  subagent batch "<task>" [--agent <name>]... [--top 2] [--cwd <dir>] [--background] [--dry-run]
  subagent stats

Examples:
  subagent config validate
  subagent info codex
  subagent route "review this refactor for regressions" --review
  subagent run "implement the CLI flag parsing in this repo" --cwd ~/Projects/subagent-cli
  subagent run "summarize these logs locally" --private --background
  subagent batch "compare approaches for background worker orchestration" --agent claude --agent gemini

Notes:
  - Auto-routing favors Codex for repo changes, Claude for review/planning, Gemini for ideation,
    Ollama for local/private work, and Antigravity for orchestration once configured.
  - Background runs write logs under ~/.config/subagent-cli/runs/.
  - Config now supports local and remote agent definitions, though remote execution commands are still in progress.
`);
}
