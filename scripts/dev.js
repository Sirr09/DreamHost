const { spawn } = require('child_process');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];

const run = (name, args) => {
  const child = spawn(npm, args, {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `[${name}]`;
  child.stdout.on('data', (chunk) => process.stdout.write(`${prefix} ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`${prefix} ${chunk}`));
  child.on('exit', (code) => {
    if (code !== 0 && !shuttingDown) {
      console.error(`${prefix} exited with code ${code}`);
      shutdown(code || 1);
    }
  });

  children.push(child);
};

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 250);
};

run('API', ['--prefix', 'server', 'run', 'dev']);
run('WEB', ['--prefix', 'client', 'run', 'dev', '--', '--host', '0.0.0.0']);

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
