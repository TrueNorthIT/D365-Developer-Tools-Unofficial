import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgPath = resolve(__dirname, '../package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

const part = process.argv[2] || 'patch'
const [maj, min, pat] = pkg.version.split('.').map(Number)

const prev = pkg.version
if (part === 'major') pkg.version = `${maj + 1}.0.0`
else if (part === 'minor') pkg.version = `${maj}.${min + 1}.0`
else if (part === 'patch') pkg.version = `${maj}.${min}.${pat + 1}`
else {
  console.error('Usage: node scripts/bump-version.mjs [major|minor|patch]')
  process.exit(1)
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`${prev} → ${pkg.version}`)
