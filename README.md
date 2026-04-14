# subagent-cli

A practical Node.js CLI for dispatching tasks to local sub-agent CLIs.

This tool is aimed at the exact case where one main agent needs to choose between different agent runtimes, delegate work in the background, and build some local memory for what tends to work best.

## Why a CLI makes sense

A CLI is a good fit if you want:

- a scriptable control surface your main agent can call from any machine
- deterministic routing rules instead of relying on the planner to remember preferences
- background and parallel fan-out without standing up a queue or web service
- a local analytics trail for which agent got picked and how often it succeeded

A CLI is not enough on its own if you need:

- durable remote job scheduling
- cross-machine queues and retries
- shared state across all hosted agents
- centralized observability or rate-limiting

For that second layer, keep this CLI as the frontend and put a queue/API behind it later.

## Install locally

```bash
cd ~/Projects/subagent-cli
npm link
```

## Quick start

```bash
subagent config init
subagent agents
subagent route "review this repo for regressions" --review
subagent run "implement a new CLI command in this repo" --cwd ~/Projects/subagent-cli
subagent run "summarize these logs locally" --private --background
subagent batch "compare delegation strategies for sub-agents" --agent claude --agent gemini
subagent stats
```

## Commands

### Config

- `subagent config init [--force]`
- `subagent config path`
- `subagent config set-default <agent>`
- `subagent config validate`

### Discovery

- `subagent agents`
- `subagent info <agent>`
- `subagent stats`

### Messaging

- `subagent message <agent> "<message>" [--dry-run]`

### Routing

- `subagent route "<task>" [--code] [--review] [--plan] [--research] [--private] [--background]`

### Execution

- `subagent run "<task>" [--agent <name>] [--cwd <dir>] [--background] [--dry-run]`
- `subagent batch "<task>" [--agent <name>]... [--top 2] [--cwd <dir>] [--background] [--dry-run]`

`--dry-run` shows the exact delegated command without executing it and does not affect routing analytics.

## Default agent roles

- `codex`: repo-aware implementation, edits, command execution
- `claude`: review, planning, critique, second-pass reasoning
- `gemini`: exploration, ideation, broad comparisons
- `ollama`: local/private/cheap background work
- `antigravity`: reserved for orchestration or remote delegation once configured

## Config

Config is stored at:

- `~/.config/subagent-cli/config.json`

Runs launched in the background write logs to:

- `~/.config/subagent-cli/runs/`

The generated config includes agent commands for `codex`, `claude`, `gemini`, and `ollama`. `antigravity` is present but disabled by default because no local binary was detected during creation.

### Current config workflow

Right now, federated-agent config is edited manually in the JSON file.

Recommended workflow:

```bash
subagent config path
$EDITOR ~/.config/subagent-cli/config.json
subagent config validate
subagent info m5
subagent agents
```

Today, the CLI can:

- initialize config
- print the config path
- set the default agent
- validate config shape
- inspect an agent definition
- route, run, batch, and message using the current config

Today, the CLI does *not yet* have dedicated config mutation commands like:

- `subagent config add-remote ...`
- `subagent config set ...`
- `subagent config enable ...`
- `subagent config disable ...`

So the current operator experience is:

- edit JSON manually
- validate with the CLI
- inspect with the CLI

### Config model

The config now supports a backwards-compatible `kind` field on agents:

- `kind: "local"` for command-based local agents
- `kind: "remote"` for federated agents using transports like webhooks

Current implementation includes:

- schema normalization
- backwards-compatible config loading
- validation
- agent inspection
- local execution and routing
- initial remote webhook messaging

### Local agent shape

Example local agent:

```json
{
  "codex": {
    "kind": "local",
    "label": "Codex",
    "enabled": true,
    "command": "codex",
    "args": ["exec", "--skip-git-repo-check"],
    "promptMode": "argv",
    "description": "Best default for repo-aware implementation, edits, and execution-heavy work.",
    "roles": ["implementer"],
    "capabilities": ["code", "repo-edits", "shell"]
  }
}
```

### Remote agent shape

Example remote agent entry:

```json
{
  "m5": {
    "kind": "remote",
    "label": "M5",
    "enabled": true,
    "description": "Infra/operator agent on machine m5.",
    "roles": ["infra-operator"],
    "capabilities": ["shell", "docker", "openclaw", "monitoring"],
    "labels": {
      "machine": "m5",
      "network": "tailscale",
      "environment": "homelab"
    },
    "transport": {
      "type": "webhook",
      "endpoint": "https://m5.tailnet.ts.net:18789/hooks/agent",
      "method": "POST"
    },
    "auth": {
      "type": "bearer",
      "secretRef": "infisical://subagent/m5/token"
    }
  }
}
```

### Remote auth and secret refs

Remote webhook auth currently supports secret refs via environment variables or Infisical.

Environment variable example:

```json
{
  "type": "bearer",
  "secretRef": "env://SUBAGENT_M5_TOKEN"
}
```

Infisical example:

```json
{
  "type": "bearer",
  "secretRef": "infisical://subagent/m5/token"
}
```

Custom header auth is also supported, for example:

```json
{
  "type": "header",
  "headerName": "x-subagent-key",
  "secretRef": "infisical://subagent/m5/key"
}
```

For Infisical-backed resolution, `subagent-cli` currently expects runtime context via environment when needed, such as:

- `SUBAGENT_INFISICAL_ENV`
- `SUBAGENT_INFISICAL_PROJECT_ID`
- `SUBAGENT_INFISICAL_TOKEN`
- `SUBAGENT_INFISICAL_DOMAIN` or `INFISICAL_API_URL`

### Remote message behavior

`subagent message <agent> "<message>"` now supports:

- local agents, by delegating through the configured local command
- remote webhook agents, by constructing a standardized JSON envelope

Example dry run:

```bash
subagent message m5 "check the queue worker logs" --dry-run
```

The remote webhook envelope currently looks like:

```json
{
  "type": "message",
  "from": "subagent-cli",
  "to": "m5",
  "correlationId": "uuid",
  "timestamp": "2026-04-14T02:00:00.000Z",
  "message": "check the queue worker logs",
  "metadata": {
    "source": "subagent-cli",
    "host": "machine-hostname",
    "priority": "normal"
  }
}
```

Headers are constructed from the configured auth block and are redacted in dry-run output.

### Validation and inspection

Useful commands while editing federated agents:

```bash
subagent config validate
subagent agents
subagent info m5
```

`subagent config validate` checks:

- config structure
- default agent validity
- required local fields like `command`
- required remote fields like `transport.type` and webhook `endpoint`
- auth type presence when auth is configured

## Suggested direction

For your use case, the right progression is:

1. Start with this CLI as the routing and delegation layer.
2. Let your main agent call it explicitly for background or comparison work.
3. Once the delegation patterns stabilize, move the execution backend to a queue or remote worker API and keep the same CLI interface.
