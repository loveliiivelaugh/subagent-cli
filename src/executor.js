import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ensureConfigDir, getRunsDir } from './config.js';

const execFileAsync = promisify(execFile);

export async function runAgent({ agentName, agentConfig, task, cwd, background = false, dryRun = false }) {
  if ((agentConfig.kind || 'local') !== 'local') {
    throw new Error(`run is only supported for local agents. Use message/task commands for remote agents like ${agentName}.`);
  }

  const commandSpec = buildCommand({ agentConfig, task });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      agent: agentName,
      cwd: cwd || process.cwd(),
      command: renderCommand(commandSpec)
    };
  }

  if (background) {
    await ensureConfigDir();
    const runId = createRunId(agentName);
    const logPath = path.join(getRunsDir(), `${runId}.log`);
    const handle = await fs.open(logPath, 'a', 0o600);

    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: cwd || process.cwd(),
      detached: true,
      stdio: ['ignore', handle.fd, handle.fd]
    });

    child.unref();
    await handle.close();

    return {
      ok: true,
      background: true,
      agent: agentName,
      pid: child.pid,
      logPath,
      command: renderCommand(commandSpec)
    };
  }

  return await new Promise((resolve) => {
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: cwd || process.cwd(),
      stdio: 'inherit'
    });

    child.on('error', (error) => {
      resolve({
        ok: false,
        agent: agentName,
        error: error.message,
        command: renderCommand(commandSpec)
      });
    });

    child.on('exit', (code, signal) => {
      resolve({
        ok: code === 0,
        agent: agentName,
        exitCode: code,
        signal,
        command: renderCommand(commandSpec)
      });
    });
  });
}

export async function runBatch({ tasks }) {
  return await Promise.all(tasks.map((task) => runAgent(task)));
}

export async function sendAgentMessage({ fromAgent = 'subagent-cli', agentName, agentConfig, message, dryRun = false }) {
  if ((agentConfig.kind || 'local') === 'local') {
    return await runAgent({
      agentName,
      agentConfig,
      task: message,
      dryRun
    });
  }

  const transport = agentConfig.transport || {};

  if (transport.type === 'webhook') {
    const envelope = {
      type: 'message',
      from: fromAgent,
      to: agentName,
      correlationId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message,
      metadata: {
        source: 'subagent-cli',
        host: os.hostname(),
        priority: 'normal'
      }
    };

    const request = await buildWebhookRequest({ agentConfig, body: envelope });

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        agent: agentName,
        transport: transport.type,
        request: redactRequestForOutput(request)
      };
    }

    const response = await fetch(request.url, request.init);
    const text = await response.text();
    let data = text;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    return {
      ok: response.ok,
      agent: agentName,
      transport: transport.type,
      status: response.status,
      statusText: response.statusText,
      request: redactRequestForOutput(request),
      response: data
    };
  }

  if (transport.type === 'ssh') {
    const commandSpec = buildSshMessageCommand({ agentName, agentConfig, message });

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        agent: agentName,
        transport: transport.type,
        command: renderCommand(commandSpec)
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(commandSpec.command, commandSpec.args, {
        env: process.env,
        maxBuffer: 1024 * 1024
      });

      return {
        ok: true,
        agent: agentName,
        transport: transport.type,
        command: renderCommand(commandSpec),
        response: stdout.trim(),
        stderr: stderr.trim() || null
      };
    } catch (error) {
      return {
        ok: false,
        agent: agentName,
        transport: transport.type,
        command: renderCommand(commandSpec),
        exitCode: error.code ?? null,
        response: error.stdout?.trim() || '',
        stderr: error.stderr?.trim() || error.message
      };
    }
  }

  throw new Error(`Unsupported remote transport: ${transport.type || 'unknown'}`);
}

function buildCommand({ agentConfig, task }) {
  const args = [...(agentConfig.args || [])];
  if ((agentConfig.promptMode || 'argv') === 'argv') {
    args.push(task);
  } else {
    throw new Error(`Unsupported promptMode: ${agentConfig.promptMode}`);
  }

  return {
    command: agentConfig.command,
    args
  };
}

function renderCommand({ command, args }) {
  return [command, ...args.map(quoteShell)].join(' ');
}

function quoteShell(value) {
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function createRunId(agentName) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${agentName}`;
}

function buildSshMessageCommand({ agentName, agentConfig, message }) {
  const transport = agentConfig.transport || {};
  const sshCommand = transport.sshCommand || 'ssh';
  const sshArgs = Array.isArray(transport.sshArgs) ? [...transport.sshArgs] : [];
  const host = transport.host;
  const openclawCommand = transport.remoteCommand || detectRemoteOpenClawCommand();
  const targetAgent = transport.agent || 'main';
  const extraArgs = Array.isArray(transport.openclawArgs) ? [...transport.openclawArgs] : [];
  const remoteParts = [
    quoteShell(openclawCommand),
    'agent',
    '--agent',
    quoteShell(targetAgent),
    '--message',
    quoteShell(message),
    ...extraArgs.map(quoteShell)
  ];

  return {
    command: sshCommand,
    args: [...sshArgs, host, remoteParts.join(' ')]
  };
}

function detectRemoteOpenClawCommand() {
  try {
    const path = execFileSync('which', ['openclaw'], {
      env: process.env,
      encoding: 'utf8'
    }).trim();
    if (path) return path;
  } catch {
    // ignore and fall through
  }

  return 'openclaw';
}

async function buildWebhookRequest({ agentConfig, body }) {
  const endpoint = agentConfig.transport?.endpoint;
  if (!endpoint) {
    throw new Error('Remote webhook agent is missing transport.endpoint');
  }

  const headers = {
    'content-type': 'application/json'
  };

  const auth = agentConfig.auth;
  const secret = await resolveSecretRef(auth?.secretRef);

  if (auth?.type === 'bearer') {
    if (!secret) throw new Error('Bearer auth requires a resolvable secretRef');
    headers.authorization = `Bearer ${secret}`;
  } else if (auth?.type === 'header') {
    if (!auth.headerName) throw new Error('Header auth requires headerName');
    if (!secret) throw new Error('Header auth requires a resolvable secretRef');
    headers[auth.headerName.toLowerCase()] = secret;
  } else if (auth?.type && auth.type !== 'none') {
    throw new Error(`Unsupported auth type: ${auth.type}`);
  }

  return {
    url: endpoint,
    init: {
      method: agentConfig.transport?.method || 'POST',
      headers,
      body: JSON.stringify(body)
    }
  };
}

async function resolveSecretRef(secretRef) {
  if (!secretRef) return null;
  if (secretRef.startsWith('env://')) {
    const envKey = secretRef.slice('env://'.length);
    return process.env[envKey] || null;
  }

  if (secretRef.startsWith('infisical://')) {
    return await resolveInfisicalSecret(secretRef);
  }

  throw new Error(`Unsupported secretRef scheme: ${secretRef}`);
}

async function resolveInfisicalSecret(secretRef) {
  const locator = secretRef.slice('infisical://'.length);
  const parts = locator.split('/').filter(Boolean);

  if (parts.length === 0) {
    throw new Error(`Invalid Infisical secretRef: ${secretRef}`);
  }

  const secretName = parts.at(-1);
  const folderParts = parts.slice(0, -1);
  const folderPath = `/${folderParts.join('/') || ''}`.replace(/\/+/g, '/');

  const args = ['secrets', 'get', secretName, '--silent', '--plain'];
  if (folderParts.length > 0) {
    args.push('--path', folderPath);
  }

  const envName = process.env.SUBAGENT_INFISICAL_ENV;
  const projectId = process.env.SUBAGENT_INFISICAL_PROJECT_ID;
  const token = process.env.SUBAGENT_INFISICAL_TOKEN;
  const domain = process.env.SUBAGENT_INFISICAL_DOMAIN || process.env.INFISICAL_API_URL;

  if (envName) args.push('--env', envName);
  if (projectId) args.push('--projectId', projectId);
  if (token) args.push('--token', token);
  if (domain) args.push('--domain', domain);

  try {
    const { stdout } = await execFileAsync('infisical', args, {
      env: process.env,
      maxBuffer: 1024 * 1024
    });

    const value = stdout.trim();
    if (!value) {
      throw new Error(`Infisical returned an empty value for ${secretRef}`);
    }

    return value;
  } catch (error) {
    const detail = error?.stderr?.trim() || error?.message || 'unknown error';
    throw new Error(`Failed to resolve Infisical secret ${secretRef}: ${detail}`);
  }
}

function redactRequestForOutput(request) {
  const headers = { ...(request.init?.headers || {}) };
  if (headers.authorization) headers.authorization = '[redacted]';

  return {
    url: request.url,
    method: request.init?.method || 'POST',
    headers,
    body: request.init?.body ? JSON.parse(request.init.body) : undefined
  };
}
