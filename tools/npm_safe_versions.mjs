// Print the newest non-prerelease version of each package published >= MIN_DAYS ago.
// Usage: node tools/npm_safe_versions.mjs [minDays] pkg[@major] ...
// Reads only registry metadata (https://registry.npmjs.org/<pkg>); installs nothing.
const [minDays, ...pkgs] = process.argv.slice(2);
const cutoff = Date.now() - Number(minDays) * 864e5;
for (const spec of pkgs) {
  const m = spec.match(/^(@?[^@]+)(?:@(\d+))?$/);
  const [name, major] = [m[1], m[2]];
  const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
  const meta = await res.json();
  const ok = Object.entries(meta.time)
    .filter(([v, t]) => /^\d+\.\d+\.\d+$/.test(v) && Date.parse(t) <= cutoff && (!major || v.split('.')[0] === major) && meta.versions[v])
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  const [v, t] = ok[0] ?? ['NONE', ''];
  const peers = v !== 'NONE' ? JSON.stringify(meta.versions[v].peerDependencies ?? {}) : '';
  const engines = v !== 'NONE' ? (meta.versions[v].engines?.node ?? '') : '';
  console.log(`${name}\t${v}\t${t.slice(0, 10)}\tnode:${engines}\tpeers:${peers}`);
}
