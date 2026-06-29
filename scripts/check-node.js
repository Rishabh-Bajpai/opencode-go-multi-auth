const REQUIRED = [22, 22, 2];
const current = process.versions.node.split('.').map(Number);

const ok =
  current[0] > REQUIRED[0] ||
  (current[0] === REQUIRED[0] && current[1] > REQUIRED[1]) ||
  (current[0] === REQUIRED[0] && current[1] === REQUIRED[1] && current[2] >= REQUIRED[2]);

if (!ok) {
  console.error(`
\x1b[31mError: Node.js >= ${REQUIRED.join('.')} is required.\x1b[0m
\x1b[33mCurrent version: ${process.versions.node}\x1b[0m

Install or upgrade with nvm:

  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  nvm install 22

Or update npm directly:

  npm install -g npm@latest
`);
  process.exit(1);
}
