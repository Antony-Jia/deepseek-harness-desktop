import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageRoot = path.join(root, 'market', 'akshare-market-analysis')
const read = (relativePath) => readFileSync(path.join(packageRoot, relativePath), 'utf8')
const manifest = JSON.parse(read('package.json'))

assert.equal(manifest.name, '@p-dsh-market/akshare-market-analysis')
assert.match(manifest.version, /^0\.1\.1$/)
assert.equal(manifest.main, 'lib/index.js')
assert.equal(manifest.exports['./client'], './lib/client.js')
assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
assert.equal(manifest.dsh.protocolVersion, 1)
assert.equal(manifest.dsh.client.platform, 'web')
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
for (const capability of ['skills', 'host', 'client', 'desktop-shell']) assert.ok(manifest.dsh.market.capabilities.includes(capability))
for (const permission of ['shell:titlebar', 'process:execute-bundled', 'network:outbound', 'storage:user', 'storage:cache']) {
  assert.ok(manifest.dsh.desktop.permissions.includes(permission), `missing permission ${permission}`)
}
const action = manifest.dsh.desktop.contributes.titlebarActions[0]
assert.equal(action.icon, 'chart-candlestick')
assert.equal(action.action.method, 'akshare.toggleAnalysisPanel')
assert.equal(action.slot, 'desktop.titlebar.workspaceActions')

const patch = read('cordis.patch.yml')
assert.match(patch, /@p-dsh-market\/akshare-market-analysis/)
assert.match(patch, /inject: \[skills, tools, subprocess, webServer\]/)
const skill = read('skills/akshare-market-analysis/SKILL.md')
assert.match(skill, /^name:\s*akshare-market-analysis/m)
assert.match(skill, /^description:/m)
for (const relativePath of [
  'lib/index.js', 'lib/client.js', 'lib/protocol.js', 'lib/schemas.js',
  'skills/akshare-market-analysis/references/data-contract.md',
  'skills/akshare-market-analysis/references/analysis-rules.md',
  'python-sidecar/pyproject.toml', 'python-sidecar/akshare-service.spec',
  'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'
]) assert.ok(existsSync(path.join(packageRoot, relativePath)), `missing ${relativePath}`)

const sourceFiles = ['lib/index.js', 'lib/client.js', 'lib/protocol.js', 'lib/schemas.js', 'python-sidecar/src/akshare_service/main.py']
for (const relativePath of sourceFiles) {
  const source = read(relativePath)
  assert.doesNotMatch(source, /\b(?:TODO|FIXME|placeholder)\b/i, `${relativePath} contains a placeholder`)
}

if (process.argv.includes('--require-runtime')) {
  const runtime = path.join(packageRoot, 'runtime', 'win32-x64', 'akshare-service.exe')
  assert.ok(existsSync(runtime), 'runtime/win32-x64/akshare-service.exe is missing')
  assert.ok(statSync(runtime).size > 1024, 'sidecar executable is unexpectedly small')
  assert.ok(existsSync(path.join(packageRoot, 'runtime', 'win32-x64', 'SHA256SUMS.txt')), 'runtime checksum is missing')
  assert.ok(existsSync(path.join(packageRoot, 'runtime', 'win32-x64', 'RUNTIME-MANIFEST.json')), 'runtime manifest is missing')
}

process.stdout.write(`validated ${manifest.name}@${manifest.version}\n`)
