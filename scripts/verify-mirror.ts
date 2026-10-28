import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

type MirroredPackage = {
  name: string
  path: string
  files: Record<string, string>
}

type MirrorManifest = {
  schemaVersion: 1
  sourceRepository: string
  sourceCommit: string
  packages: MirroredPackage[]
}

const repositoryRoot = join(import.meta.dir, '..')
const manifestPath = join(repositoryRoot, '.mirror-manifest.json')
// Accept the former owner while existing package releases transition to the current repository.
const expectedRepositories = new Set([
  'git+https://github.com/fiftyone/metricpanel-js.git',
  'git+https://github.com/fiftyone-digital/metricpanel-js.git',
])
const ignoredNames = new Set(['coverage', 'dist', 'node_modules', '.turbo'])

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = []

  async function visit(currentDirectory: string): Promise<void> {
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      if (ignoredNames.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue

      const absolutePath = join(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath)
      } else if (entry.isFile()) {
        files.push(relative(directory, absolutePath))
      }
    }
  }

  await visit(directory)
  return files.sort()
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as MirrorManifest

if (manifest.schemaVersion !== 1) throw new Error('Unsupported mirror manifest schema')
if (manifest.sourceRepository !== 'fiftyone-digital/metricpanel') {
  throw new Error(`Unexpected source repository: ${manifest.sourceRepository}`)
}
if (!/^[0-9a-f]{40}$/.test(manifest.sourceCommit)) {
  throw new Error(`Invalid source commit: ${manifest.sourceCommit}`)
}

for (const mirroredPackage of manifest.packages) {
  const packageDirectory = join(repositoryRoot, mirroredPackage.path)
  const actualFiles = await listFiles(packageDirectory)
  const expectedFiles = Object.keys(mirroredPackage.files).sort()

  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `${mirroredPackage.name} file set differs from the generated mirror manifest\n` +
        `Expected: ${expectedFiles.join(', ')}\nActual: ${actualFiles.join(', ')}`
    )
  }

  for (const file of expectedFiles) {
    const contents = await readFile(join(packageDirectory, file))
    const actualHash = sha256(contents)
    if (actualHash !== mirroredPackage.files[file]) {
      throw new Error(`${mirroredPackage.name}/${file} differs from the canonical source export`)
    }
  }

  const packageJson = JSON.parse(
    await readFile(join(packageDirectory, 'package.json'), 'utf8')
  ) as {
    name?: string
    repository?: { url?: string; directory?: string }
  }

  if (packageJson.name !== mirroredPackage.name) {
    throw new Error(`${mirroredPackage.path}/package.json has an unexpected package name`)
  }
  if (!packageJson.repository || !expectedRepositories.has(packageJson.repository.url ?? '')) {
    throw new Error(`${mirroredPackage.name} must point npm metadata at metricpanel-js`)
  }
  if (packageJson.repository.directory !== mirroredPackage.path) {
    throw new Error(`${mirroredPackage.name} has an incorrect repository.directory`)
  }
}

console.log(
  `Verified ${manifest.packages.length} mirrored packages from ${manifest.sourceRepository}@${manifest.sourceCommit}`
)
