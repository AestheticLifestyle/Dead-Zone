#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  DEAD ZONE — Startup script
//  Launches the game server + a Cloudflare tunnel so friends
//  anywhere can join with just a link.
// ─────────────────────────────────────────────────────────────

const { spawn, execSync } = require('child_process');
const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const PORT   = 3000;
const CF_DIR = path.join(__dirname, 'bin');
const CF_BIN = path.join(CF_DIR, os.platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared');

// ── Cloudflared download URLs ────────────────────────────────
const CF_URLS = {
  win32:  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  darwin: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64',
  linux:  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
};

// Robust download that properly follows ALL redirects (http & https)
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    function follow(u) {
      // Pick the right module based on the current URL's protocol
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'DeadZone-Launcher' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect — could be http or https
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) {
          fs.unlinkSync(dest);
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', err => { fs.unlinkSync(dest); reject(err); });
      }).on('error', err => {
        try { fs.unlinkSync(dest); } catch(e) {}
        reject(err);
      });
    }
    follow(url);
  });
}

async function ensureCloudflared() {
  if (fs.existsSync(CF_BIN)) return;
  const url = CF_URLS[os.platform()] || CF_URLS.linux;
  if (!url) throw new Error(`Unsupported platform: ${os.platform()}`);
  fs.mkdirSync(CF_DIR, { recursive: true });
  console.log('  Downloading cloudflared (one-time, ~30MB)...');
  await downloadFile(url, CF_BIN);
  if (os.platform() !== 'win32') fs.chmodSync(CF_BIN, 0o755);
  console.log('  Download complete!');
}

async function startTunnel() {
  return new Promise((resolve, reject) => {
    console.log('  Creating public link...');
    const cf = spawn(CF_BIN, ['tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;
    function checkOutput(data) {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9\-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        resolve({ proc: cf, url: match[0] });
      }
    }

    cf.stdout.on('data', checkOutput);
    cf.stderr.on('data', checkOutput);
    cf.on('error', err => {
      if (!resolved) reject(err);
    });

    setTimeout(() => {
      if (!resolved) reject(new Error('Cloudflare tunnel timed out after 45s'));
    }, 45000);
  });
}

function openBrowser(url) {
  try {
    const cmd = os.platform() === 'win32' ? 'start'
              : os.platform() === 'darwin' ? 'open'
              : 'xdg-open';
    spawn(cmd, [url], { shell: true, detached: true, stdio: 'ignore' });
  } catch (e) {
    // Silently fail — user can manually open the URL
  }
}

async function main() {
  console.log('');
  console.log('  ========================================');
  console.log('    DEAD ZONE - Online Multiplayer');
  console.log('  ========================================');

  // ── Install dependencies if needed ──────────
  if (!fs.existsSync(path.join(__dirname, 'node_modules', 'express'))) {
    console.log('  Installing dependencies (first time only)...');
    try {
      execSync('npm install --production', { cwd: __dirname, stdio: 'inherit' });
    } catch (e) {
      console.error('  ERROR: Failed to install dependencies.');
      console.error('  Make sure Node.js and npm are installed: https://nodejs.org');
      process.exit(1);
    }
  }

  // ── Start the game server ────────────────────
  console.log('  Starting game server...');
  require('./server.js');

  const localURL = `http://localhost:${PORT}`;
  console.log(`  Game server running at ${localURL}`);

  // Auto-open browser
  openBrowser(localURL);

  // ── Download + start cloudflared ─────────────
  try {
    await ensureCloudflared();
    const { proc, url } = await startTunnel();

    console.log('');
    console.log('  ========================================');
    console.log('  PUBLIC LINK (share this with friends!):');
    console.log(`  ${url}`);
    console.log('  ========================================');
    console.log('  Anyone with this link can join your game!');
    console.log('  Press Ctrl+C to stop.');
    console.log('');

    process.on('SIGINT',  () => { proc.kill(); process.exit(0); });
    process.on('SIGTERM', () => { proc.kill(); process.exit(0); });

  } catch (err) {
    console.log('');
    console.log('  Could not create public tunnel: ' + err.message);
    console.log(`  You can still play locally at ${localURL}`);
    console.log('  (For online multiplayer, make sure your firewall allows cloudflared)');
    console.log('');
  }
}

main().catch(err => {
  console.error('  Fatal error:', err.message);
  console.error('  Press any key to close...');
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  }
});
