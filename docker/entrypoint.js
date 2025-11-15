// Clean, canonical importer entrypoint
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const WORKFLOW_DIR = '/home/node/.n8n/workflows';

function log(...args) {
  console.log('[entrypoint]', ...args);
}

function importWorkflowCLI(filePath) {
  log('Importing via CLI:', filePath);
  try {
    const res = spawnSync('n8n', ['import:workflow', '--input', filePath], { stdio: 'inherit' });
    if (res.error) {
      log('Error importing', filePath, res.error);
      return false;
    }
    if (res.status !== 0) {
      log('n8n import returned non-zero status for', filePath, 'status=', res.status);
      return false;
    }
    return true;
  } catch (err) {
    log('Exception importing', filePath, err);
    return false;
  }
}

function startN8n() {
  log('Starting n8n process');
  const child = spawn('n8n', [], { stdio: 'inherit' });

  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
    process.on(sig, () => {
      try { child.kill(sig); } catch (e) { /* ignore */ }
    });
  });

  child.on('exit', (code, signal) => {
    log('n8n exited', { code, signal });
    process.exit(code === null ? 0 : code);
  });

  return child;
}

function restRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${process.env.N8N_BASIC_AUTH_USER || ''}:${process.env.N8N_BASIC_AUTH_PASSWORD || ''}`).toString('base64');
    const opts = {
      hostname: process.env.N8N_HOST || '127.0.0.1',
      port: process.env.N8N_PORT || 5678,
      path,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const result = { statusCode: res.statusCode, body: data };
        try { result.json = JSON.parse(data); } catch (e) { result.json = null; }
        resolve(result);
      });
    });

    req.on('error', (e) => reject(e));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForN8nReady(retries = 120, intervalMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await restRequest('GET', '/rest/workflows');
      if (r.statusCode === 200) return true;
      if (r.statusCode === 401) {
        log('REST returned 401; treating n8n as ready.');
        return true;
      }
    } catch (e) { /* retry */ }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return false;
}

async function importMissingWorkflows() {
  try {
    const files = fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('.imported_'));
    for (const f of files) {
      const full = path.join(WORKFLOW_DIR, f);
      log('Processing workflow file:', full);
      let content;
      try { content = fs.readFileSync(full, 'utf8'); } catch (e) { log('Could not read', full); continue; }
      let obj = null;
      try { obj = JSON.parse(content); } catch (e) { obj = null; }

      if (obj && obj.name) {
        try {
          const listResp = await restRequest('GET', '/rest/workflows');
          if (listResp && listResp.statusCode === 200 && Array.isArray(listResp.json)) {
            const existing = listResp.json.find((w) => w.name === obj.name);
            if (existing && existing.id) {
              try {
                const payload = Object.assign({}, obj);
                payload.id = existing.id;
                const put = await restRequest('PUT', `/rest/workflows/${existing.id}`, payload);
                if (put.statusCode >= 200 && put.statusCode < 300) {
                  log('Updated existing workflow via REST PUT:', obj.name, existing.id);
                  continue;
                }
                log('REST PUT did not succeed for', obj.name, put.statusCode);
              } catch (e) { log('REST PUT error for', obj.name); }
            }
          }
        } catch (e) { /* ignore and fallback */ }
      }

      const ok = importWorkflowCLI(full);
      if (!ok) log('Import failed for', full);
    }

    // watch for changes
    try {
      const debounce = new Map();
      fs.watch(WORKFLOW_DIR, (ev, filename) => {
        if (!filename || !filename.endsWith('.json') || filename.startsWith('.imported_')) return;
        const full = path.join(WORKFLOW_DIR, filename);
        if (debounce.has(full)) clearTimeout(debounce.get(full));
        const t = setTimeout(() => { importMissingWorkflows().catch(() => {}); debounce.delete(full); }, 500);
        debounce.set(full, t);
      });
      log('File watcher established for', WORKFLOW_DIR);
    } catch (e) { log('Watcher failed:', e && e.message); }
  } catch (err) { log('Error scanning workflows dir:', err && err.message); }
}

async function main() {
  startN8n();
  log('Waiting for n8n HTTP API to become available...');
  const ready = await waitForN8nReady();
  if (!ready) { log('n8n not ready, skipping import'); return; }
  await importMissingWorkflows();
}

main().catch((e) => { log('Unhandled error in importer:', e && e.message ? e.message : e); process.exit(1); });

process.on('uncaughtException', (err) => { log('Uncaught exception:', err && err.stack ? err.stack : err); process.exit(1); });
process.on('unhandledRejection', (reason) => { log('Unhandled rejection:', reason); process.exit(1); });

