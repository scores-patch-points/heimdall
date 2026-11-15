// connectors/github.mjs: read-only pull from a PUBLIC GitHub repo, always at a full commit sha.
// A ref (branch, tag) is resolved to a commit once, and the commit is what gets recorded; files are
// fetched at that commit and their sha256 is recorded, so the link can be re-checked byte for byte.
// No token, no writes, nothing pushed. (Creating or publishing repos is not something this surface does.)
import crypto from 'node:crypto';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const UA = { 'user-agent': 'heimdall-connector', accept: 'application/vnd.github+json' };

export async function resolveCommit(repo, ref = 'HEAD') {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const r = await fetch(`${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`, { headers: UA });
  if (!r.ok) throw new Error(`github: cannot resolve ${repo}@${ref}: ${r.status}`);
  return (await r.json()).sha;
}

export async function fetchFile({ repo, commit, path, sha256 }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('github: a full 40-character commit is required');
  const url = `${RAW}/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, { headers: { 'user-agent': UA['user-agent'] } });
  if (!r.ok) throw new Error(`github: ${url}: ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 && got !== sha256) throw new Error(`github: ${repo}@${commit}:${path} is ${got}, pinned ${sha256}`);
  return { bytes, link: { repo, commit, path, sha256: got, url } };
}
