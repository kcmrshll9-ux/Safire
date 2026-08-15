import fs from 'node:fs/promises';
import { startMemoryMcpStdio } from './lib/memory/mcp.mjs';
import { ProfileValidationError, validateProfile } from './lib/memory/profile.mjs';
import vaultConfig from './vault-config.cjs';

const { resolveVaultPath } = vaultConfig;
const MAX_PROFILE_CONFIG_BYTES = 1_048_576;

class MemoryMcpCliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryMcpCliError';
  }
}

function parseArguments(argv) {
  const options = { disabled: false };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--disabled') {
      if (seen.has('--disabled')) throw new MemoryMcpCliError('Duplicate --disabled option');
      seen.add('--disabled');
      options.disabled = true;
      continue;
    }

    let name;
    let value;
    if (argument === '--vault' || argument === '--profile-config') {
      name = argument;
      value = argv[index + 1];
      index += 1;
    } else if (argument.startsWith('--vault=')) {
      name = '--vault';
      value = argument.slice('--vault='.length);
    } else if (argument.startsWith('--profile-config=')) {
      name = '--profile-config';
      value = argument.slice('--profile-config='.length);
    } else {
      throw new MemoryMcpCliError('Unsupported command-line option');
    }

    if (seen.has(name)) throw new MemoryMcpCliError(`Duplicate ${name} option`);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new MemoryMcpCliError(`${name} requires a value`);
    }
    seen.add(name);
    if (name === '--vault') options.vaultDir = value;
    if (name === '--profile-config') options.profileConfig = value;
  }

  return options;
}

async function readBoundedProfileFile(profilePath) {
  let handle;
  try {
    handle = await fs.open(profilePath, 'r');
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_PROFILE_CONFIG_BYTES) {
      throw new MemoryMcpCliError('Profile configuration file is invalid');
    }

    const buffer = Buffer.alloc(MAX_PROFILE_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PROFILE_CONFIG_BYTES) {
      throw new MemoryMcpCliError('Profile configuration file is invalid');
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error instanceof MemoryMcpCliError) throw error;
    throw new MemoryMcpCliError('Profile configuration file could not be read');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function parseProfileConfiguration(profilePath, { required }) {
  if (profilePath === undefined) {
    if (required) throw new MemoryMcpCliError('Enabled memory MCP requires --profile-config');
    return null;
  }

  const raw = await readBoundedProfileFile(profilePath);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemoryMcpCliError('Profile configuration file is invalid');
  }
  return validateProfile(parsed);
}

function safeStartupMessage(error) {
  if (error instanceof ProfileValidationError) return 'Safire memory MCP profile configuration is invalid.';
  if (error instanceof MemoryMcpCliError) return `Safire memory MCP startup error: ${error.message}.`;
  return 'Safire memory MCP could not start safely.';
}

let runtime;
try {
  const options = parseArguments(process.argv.slice(2));
  const enabled = !options.disabled;
  const profile = await parseProfileConfiguration(options.profileConfig, { required: enabled });
  const vaultDir = resolveVaultPath({ vaultDir: options.vaultDir });
  runtime = await startMemoryMcpStdio({ vaultDir, profile, enabled });
} catch (error) {
  // stdout belongs exclusively to the stdio JSON-RPC transport. Never log profile JSON or memory contents.
  process.stderr.write(`${safeStartupMessage(error)}\n`);
  process.exitCode = 1;
}

let stopping = false;
function stop() {
  if (stopping || !runtime) return;
  stopping = true;
  void runtime.server.close();
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.stdin.once('end', stop);
