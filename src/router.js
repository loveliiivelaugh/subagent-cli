const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'we',
  'with'
]);

const AGENT_PROFILES = {
  codex: {
    code: 5,
    repo: 5,
    execute: 4,
    review: 3,
    research: 2,
    planning: 3,
    ideation: 2,
    privacy: 2,
    orchestration: 3
  },
  claude: {
    code: 3,
    repo: 3,
    execute: 2,
    review: 5,
    research: 4,
    planning: 5,
    ideation: 4,
    privacy: 1,
    orchestration: 2
  },
  gemini: {
    code: 3,
    repo: 2,
    execute: 2,
    review: 3,
    research: 5,
    planning: 3,
    ideation: 5,
    privacy: 1,
    orchestration: 2
  },
  ollama: {
    code: 2,
    repo: 1,
    execute: 1,
    review: 2,
    research: 1,
    planning: 2,
    ideation: 2,
    privacy: 5,
    orchestration: 2
  },
  antigravity: {
    code: 2,
    repo: 2,
    execute: 3,
    review: 2,
    research: 2,
    planning: 4,
    ideation: 2,
    privacy: 1,
    orchestration: 5
  }
};

const SIGNALS = [
  {
    name: 'code',
    weight: 2.2,
    keywords: ['bug', 'build', 'cli', 'code', 'debug', 'fix', 'implement', 'patch', 'refactor', 'test']
  },
  {
    name: 'repo',
    weight: 2,
    keywords: ['branch', 'file', 'git', 'project', 'repo', 'repository', 'workspace']
  },
  {
    name: 'execute',
    weight: 1.8,
    keywords: ['apply', 'change', 'edit', 'run', 'ship', 'write']
  },
  {
    name: 'review',
    weight: 2.1,
    keywords: ['audit', 'compare', 'critic', 'review', 'risk']
  },
  {
    name: 'research',
    weight: 1.8,
    keywords: ['explore', 'investigate', 'research', 'survey']
  },
  {
    name: 'planning',
    weight: 1.9,
    keywords: ['approach', 'architecture', 'design', 'plan', 'strategy']
  },
  {
    name: 'ideation',
    weight: 1.8,
    keywords: ['brainstorm', 'ideas', 'name', 'options']
  },
  {
    name: 'privacy',
    weight: 2.4,
    keywords: ['airgap', 'confidential', 'local', 'offline', 'private']
  },
  {
    name: 'orchestration',
    weight: 2.3,
    keywords: ['agent', 'delegate', 'dispatch', 'fanout', 'orchestrate', 'parallel', 'queue', 'workers']
  }
];

export function routeTask({ task, config, flags = {} }) {
  const enabledAgents = Object.entries(config.agents || {})
    .filter(([, agent]) => agent.enabled)
    .map(([name, agent]) => ({ name, agent }));

  if (enabledAgents.length === 0) {
    throw new Error('No enabled agents found. Run `subagent config init --force` or edit the config.');
  }

  const normalizedTask = String(task || '').trim();
  const matches = scoreSignals(normalizedTask, flags);
  const historyBoosts = buildHistoryBoosts(config.analytics?.runs || [], normalizedTask);

  const ranked = enabledAgents
    .map(({ name, agent }) => {
      const profile = AGENT_PROFILES[name] || {};
      let score = 0;
      const reasons = [];

      for (const signal of matches) {
        const strength = profile[signal.name] || 0;
        if (!strength) continue;
        const contribution = strength * signal.weight;
        score += contribution;
        reasons.push(`${signal.name}+${contribution.toFixed(1)}`);
      }

      const boost = historyBoosts[name] || 0;
      if (boost > 0) {
        score += boost;
        reasons.push(`history+${boost.toFixed(1)}`);
      }

      if (flags.background && name === 'ollama') {
        score += 2;
        reasons.push('background+2.0');
      }

      if (flags.parallel && (name === 'gemini' || name === 'antigravity')) {
        score += 1.5;
        reasons.push('parallel+1.5');
      }

      if (flags.agent && flags.agent === name) {
        score += 100;
        reasons.push('forced+100');
      }

      return {
        name,
        label: agent.label,
        score: round(score),
        reasons,
        description: agent.description
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const selected = ranked[0];

  return {
    selected,
    candidates: ranked,
    matchedSignals: matches.map((signal) => signal.name)
  };
}

function scoreSignals(task, flags) {
  const text = `${task} ${collectFlagHints(flags)}`.toLowerCase();
  const signals = [];

  for (const signal of SIGNALS) {
    let hits = 0;
    for (const keyword of signal.keywords) {
      if (text.includes(keyword)) hits += 1;
    }

    if (hits > 0) {
      signals.push({
        name: signal.name,
        weight: signal.weight * hits
      });
    }
  }

  if (flags.private) {
    signals.push({ name: 'privacy', weight: 2.5 });
  }

  if (flags.review) {
    signals.push({ name: 'review', weight: 2.5 });
  }

  if (flags.plan) {
    signals.push({ name: 'planning', weight: 2.5 });
  }

  if (flags.research) {
    signals.push({ name: 'research', weight: 2.5 });
  }

  if (flags.code) {
    signals.push({ name: 'code', weight: 2.5 });
    signals.push({ name: 'repo', weight: 2 });
  }

  if (signals.length === 0) {
    signals.push({ name: 'planning', weight: 1.2 });
    signals.push({ name: 'code', weight: 0.8 });
  }

  return combineSignals(signals);
}

function collectFlagHints(flags) {
  return Object.entries(flags)
    .filter(([, value]) => value === true)
    .map(([key]) => key)
    .join(' ');
}

function combineSignals(signals) {
  const totals = new Map();
  for (const signal of signals) {
    totals.set(signal.name, (totals.get(signal.name) || 0) + signal.weight);
  }

  return [...totals.entries()]
    .map(([name, weight]) => ({ name, weight }))
    .sort((a, b) => b.weight - a.weight);
}

function buildHistoryBoosts(history, task) {
  const taskTokens = tokenize(task);
  const boosts = {};

  for (const run of history.slice(-30)) {
    if (!run.success || !run.task) continue;
    const overlap = overlapRatio(taskTokens, tokenize(run.task));
    if (overlap <= 0) continue;
    boosts[run.agent] = (boosts[run.agent] || 0) + overlap * 2.5;
  }

  return boosts;
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token && !STOP_WORDS.has(token));
}

function overlapRatio(left, right) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  let matches = 0;
  for (const token of left) {
    if (rightSet.has(token)) matches += 1;
  }
  return matches / Math.max(left.length, right.length);
}

function round(value) {
  return Math.round(value * 10) / 10;
}
