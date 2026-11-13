import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseEnterpriseReleaseTrust } from '../electron/services/enterpriseReleaseProof'
import { enterpriseOfficeOrigin } from '../../src/shared/enterpriseModels'

const desktop = resolve(import.meta.dir, '..')
const outdir = Bun.argv[2] ? resolve(Bun.argv[2]) : resolve(desktop, 'electron-dist')
const trustPath = Bun.env.LIYUAN_DESKTOP_BUILD_UPDATE_TRUST_FILE
const trust = trustPath ? parseEnterpriseReleaseTrust(JSON.parse(await readFile(trustPath, 'utf8'))) : undefined
const officeHttpOrigin = Bun.env.VITE_LIYUAN_ENTERPRISE_BUILD === '1' ? enterpriseOfficeOrigin : undefined

const result = await Bun.build({
  entrypoints: [resolve(desktop, 'electron/main.ts')], outdir,
  naming: 'main.cjs', target: 'node', format: 'cjs', external: ['electron', 'node-pty'],
  define: {
    LIYUAN_DESKTOP_UPDATE_TRUST: trust ? JSON.stringify(JSON.stringify(trust)) : 'undefined',
    LIYUAN_DESKTOP_OFFICE_HTTP_ORIGIN: officeHttpOrigin ? JSON.stringify(officeHttpOrigin) : 'undefined',
  },
})
if (!result.success) {
  for (const log of result.logs) console.error(log.message)
  throw new Error('Could not bundle the Electron main process')
}
