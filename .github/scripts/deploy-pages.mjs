import { appendFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';

const env = process.env;
const artifactId = Number(env.PAGES_ARTIFACT_ID);
if (!Number.isSafeInteger(artifactId) || artifactId <= 0) {
  throw new Error('The Pages archive upload did not return a valid artifact ID.');
}

const identity = await fetch(env.ACTIONS_ID_TOKEN_REQUEST_URL, {
  headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  redirect: 'error',
});
if (!identity.ok) throw new Error(`GitHub Actions identity request failed (${identity.status}).`);
const { value: oidcToken } = await identity.json();
if (!oidcToken) throw new Error('GitHub Actions did not issue a deployment identity.');

const endpoint = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/pages/deployments`;
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function github(path, options = {}) {
  const response = await fetch(path, { ...options, headers, redirect: 'error' });
  if (!response.ok) {
    throw new Error(`GitHub Pages request failed (${response.status}, ${response.headers.get('x-github-request-id') || 'no request ID'}).`);
  }
  return response.json();
}

// Use the finalized archive ID returned by the upload action.
const deployment = await github(endpoint, {
  method: 'POST',
  body: JSON.stringify({
    artifact_id: artifactId,
    pages_build_version: env.GITHUB_SHA,
    oidc_token: oidcToken,
  }),
});
const id = deployment.id || deployment.status_url?.split('/').at(-1);
if (!id) throw new Error('GitHub Pages did not return a deployment ID.');
console.log(`Created Pages deployment ${id} for artifact ${artifactId}.`);

const terminalErrors = new Set(['deployment_failed', 'deployment_cancelled', 'deployment_lost']);
const deadline = Date.now() + 180_000;
let previous;
while (Date.now() < deadline) {
  const result = await github(`${endpoint}/${encodeURIComponent(id)}`);
  if (result.status !== previous) {
    console.log(`Pages deployment status: ${result.status}`);
    previous = result.status;
  }
  if (result.status === 'succeed') {
    if (deployment.page_url) await appendFile(env.GITHUB_OUTPUT, `page_url=${deployment.page_url}\n`);
    process.exit(0);
  }
  if (terminalErrors.has(result.status)) throw new Error(`GitHub Pages reported ${result.status}.`);
  await wait(5000);
}
throw new Error('GitHub Pages took more than three minutes to confirm the deployment.');
