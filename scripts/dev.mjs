import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifierRoot = path.join(projectRoot, 'zero-one-api-verifier');
const verifierPython = path.join(verifierRoot, '.venv', 'bin', 'python');
const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const forwardedArgs = process.argv.slice(2);

const verifier = spawn(
  verifierPython,
  ['-m', 'uvicorn', 'web.server:app', '--host', '127.0.0.1', '--port', '8012', '--reload'],
  {
    cwd: verifierRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      VERIDROP_JOBS_DIR: process.env.VERIDROP_JOBS_DIR || path.join(verifierRoot, 'web_data', 'jobs'),
      VERIDROP_WISHLIST_PATH:
        process.env.VERIDROP_WISHLIST_PATH || path.join(verifierRoot, 'web_data', 'wishlist.txt'),
    },
  },
);

const vite = spawn(process.execPath, [viteCli, ...forwardedArgs], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

const children = [verifier, vite];
let stopping = false;

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => {
    if (!child.killed) child.kill(signal);
  });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

children.forEach((child) => {
  child.on('error', (error) => {
    console.error(error.message);
    stop();
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    if (stopping) return;
    process.exitCode = code ?? 1;
    stop();
  });
});
