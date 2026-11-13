import { SQL } from 'bun'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadControlConfig } from './config'

const directory = join(import.meta.dir, '../migrations')

async function migrationFiles() {
  const names = (await readdir(directory)).filter(file => /^\d{4}-[a-z0-9-]+\.sql$/u.test(file)).sort()
  return Promise.all(names.map(async name => {
    const bytes = await readFile(join(directory, name))
    return { name, bytes, checksum: createHash('sha256').update(bytes).digest('hex') }
  }))
}

export async function assertMigrationsApplied(database: SQL) {
  const applied = new Map((await database<{ name: string, checksum: string }[]>`SELECT name, checksum FROM enterprise_schema_migrations`)
    .map(row => [row.name, row.checksum]))
  if ((await migrationFiles()).some(file => applied.get(file.name) !== file.checksum)) throw new Error('Run enterprise control migrations before starting the service')
}

export async function migrate(database: SQL): Promise<void> {
  const files = await migrationFiles()
  await database.begin(async sql => {
    await sql`SELECT pg_advisory_xact_lock(164905, 1)`
    await sql`CREATE TABLE IF NOT EXISTS enterprise_schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`
    for (const { name, bytes, checksum } of files) {
      const [previous] = await sql<{ checksum: string }[]>`SELECT checksum FROM enterprise_schema_migrations WHERE name = ${name}`
      if (previous) {
        if (previous.checksum !== checksum) throw new Error(`Applied migration ${name} has changed`)
        continue
      }
      // The only source of SQL text is a versioned application migration file.
      await sql.unsafe(bytes.toString('utf8')).simple()
      await sql`INSERT INTO enterprise_schema_migrations (name, checksum) VALUES (${name}, ${checksum})`
    }
  })
}

if (import.meta.main) {
  try {
    const database = new SQL(loadControlConfig(Bun.env).databaseUrl)
    try { await migrate(database) }
    finally { await database.close() }
    console.log('Enterprise control database migrations applied')
  } catch {
    console.error('Enterprise database migration failed. Check the development database connection and migration checksums.')
    process.exitCode = 1
  }
}
