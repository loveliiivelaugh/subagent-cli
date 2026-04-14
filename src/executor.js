import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureConfigDir, getRunsDir } from './config.js';

export async function runAgent({ agentName, agentConfig, task, cwd, background = false, dryRun = false }) {
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
