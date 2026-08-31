import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const catalogPath = fileURLToPath(new URL('market/catalog-v1.json', root))
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
const marketName = /^@p-dsh-market\/[a-z0-9][a-z0-9._-]*$/

function npmView(name) {
  const args = ['view', name, '--json']
  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  }
  return execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function localManifest(name) {
  const prefix = '@p-dsh-market/'
  if (!name.startsWith(prefix)) return null
  const file = join(fileURLToPath(root), 'market', name.slice(prefix.length), 'package.json')
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

function manifestFor(name) {
  try {
    return JSON.parse(npmView(name))
  } catch (error) {
    // A package can be added to the source catalog in the same change as its
    // market package, before its first npm publish. Validate that local
    // manifest now; once the package is published npm remains authoritative.
    const local = localManifest(name)
    const diagnostic = `${error?.stderr || ''} ${error?.stdout || ''}`
    if (local && /E404|404\s+Not Found|not found/i.test(diagnostic)) {
      process.stdout.write(`using local manifest ${name}@${local.version}\n`)
      return local
    }
    throw error
  }
}

assert.deepEqual(Object.keys(catalog).sort(), ['packages', 'schemaVersion'])
assert.equal(catalog.schemaVersion, 1)
assert.ok(Array.isArray(catalog.packages))
assert.ok(catalog.packages.length > 0 && catalog.packages.length <= 50)
assert.equal(new Set(catalog.packages).size, catalog.packages.length)
assert.deepEqual(catalog.packages, [...catalog.packages].sort())

for (const name of catalog.packages) {
  assert.match(name, marketName)
  const manifest = manifestFor(name)
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
