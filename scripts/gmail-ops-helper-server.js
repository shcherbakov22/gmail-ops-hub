#!/usr/bin/env node

const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const host = process.env.GMAIL_OPS_HELPER_HOST || '127.0.0.1';
const port = Number(process.env.GMAIL_OPS_HELPER_PORT || 4010);
const scriptDir = process.env.GMAIL_OPS_SCRIPT_DIR || '/opt/n8n/gmail-ops-hub-scripts';
const { classify } = require(path.join(scriptDir, 'classify-email-for-n8n.js'));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function runScript(script, payload) {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const result = spawnSync(`${scriptDir}/${script}`, [b64], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `exit ${result.status}`).trim());
  }
  return JSON.parse(result.stdout);
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      writeJson(res, 200, { ok: true, service: 'gmail-ops-helper' });
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    const payload = JSON.parse(await readBody(req) || '{}');
    if (req.url === '/classify') {
      writeJson(res, 200, classify(payload));
      return;
    }
    if (req.url === '/learn') {
      writeJson(res, 200, runScript('record-learned-rule.js', payload));
      return;
    }

    writeJson(res, 404, { error: 'not_found' });
  } catch (error) {
    writeJson(res, 500, { error: String(error.message || error) });
  }
});

server.listen(port, host, () => {
  console.error(`Gmail ops helper listening on http://${host}:${port}`);
});
