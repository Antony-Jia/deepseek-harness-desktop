import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const catalogPath = fileURLToPath(new URL('market/catalog-v1.json', root))
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
const marketName = /^@p-dsh-market\/[a-z0-9][a-z0-9._-]*$/

function npmView(name) {
  const args = ['view', name, '--json']
  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { encoding: 'utf8' })
  }
  return execFileSync('npm', args, { encoding: 'utf8' })
}

assert.deepEqual(Object.keys(catalog).sort(), ['packages', 'schemaVersion'])
assert.equal(catalog.schemaVersion, 1)
assert.ok(Array.isArray(catalog.packages))
assert.ok(catalog.packages.length > 0 && catalog.packages.length <= 50)
assert.equal(new Set(catalog.packages).size, catalog.packages.length)
assert.deepEqual(catalog.packages, [...catalog.packages].sort())

for (const name of catalog.packages) {
  assert.match(name, marketName)
  const manifest = JSON.parse(npmView(name))
  assert.equal(manifest.name, name)
  assert.equal(typeof manifest.version, 'string')
  assert.ok(manifest.version.length > 0)
  assert.equal(typeof manifest.main, 'string')
  assert.ok(manifest.main.length > 0)
  assert.equal(typeof manifest.exports?.['./client'], 'string')
  assert.ok(manifest.exports['./client'].length > 0)
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(typeof manifest.dsh?.bundle?.patch, 'string')
  assert.ok(manifest.dsh.bundle.patch.length > 0)
  assert.equal(typeof manifest.dsh?.market?.displayName, 'string')
  assert.ok(manifest.dsh.market.displayName.trim().length > 0)
  assert.ok(Array.isArray(manifest.dsh.market.capabilities))
  for (const capability of ['skills', 'host', 'client']) {
    assert.ok(manifest.dsh.market.capabilities.includes(capability))
  }
  process.stdout.write(`validated ${name}@${manifest.version}\n`)
}
