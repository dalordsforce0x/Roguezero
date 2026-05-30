import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

if (process.platform !== 'linux') {
  process.exit(0);
}

const hasAnyLinuxBinary = (candidates) => candidates.some((pkgName) => {
  try {
    requireFromHere.resolve(`${pkgName}/package.json`, { paths: [process.cwd()] });
    return true;
  } catch {
    return false;
  }
});

const getInstalledVersion = (packageName) => {
  try {
    const pkgPath = requireFromHere.resolve(`${packageName}/package.json`, { paths: [process.cwd()] });
    const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkgJson.version;
  } catch {
    return null;
  }
};

const installs = [];

if (!hasAnyLinuxBinary(['lightningcss-linux-x64-gnu', 'lightningcss-linux-x64-musl'])) {
  const version = getInstalledVersion('lightningcss') ?? '1.32.0';
  installs.push(`lightningcss-linux-x64-gnu@${version}`);
}

if (!hasAnyLinuxBinary(['@tailwindcss/oxide-linux-x64-gnu', '@tailwindcss/oxide-linux-x64-musl'])) {
  const version = getInstalledVersion('@tailwindcss/oxide') ?? '4.1.13';
  installs.push(`@tailwindcss/oxide-linux-x64-gnu@${version}`);
}

if (installs.length > 0) {
  execSync(`npm install --no-save ${installs.join(' ')}`, { stdio: 'inherit' });
}