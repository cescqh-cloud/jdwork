import type { EnterpriseModelCatalog } from '../../../../src/shared/enterpriseModels'
import type { EnterpriseDemandHost } from './enterpriseDemand'
import type { EnterpriseDemandLocalHost } from './enterpriseDemandLocal'
import type { EnterpriseMemoryHost } from './enterpriseMemory'
import type { EnterpriseMemoryLocalHost } from './enterpriseMemoryLocal'
import type { EnterpriseDeliveryHost } from './enterpriseDelivery'

export const enterpriseFeatures = ['demands', 'models', 'memories', 'updates'] as const

export type EnterpriseBootstrap = {
  user: { id: string; displayName: string; roles: string[] }
  device: { id: string; platform: string; clientVersion: string }
  policy: {
    revision: number
    expiresAt: string
    features: Record<typeof enterpriseFeatures[number], boolean>
  }
  cursor: number
}

export type EnterpriseIssue =
  | 'invalidOrigin'
  | 'invalidChallenge'
  | 'enrollmentRejected'
  | 'secureStorage'
  | 'network'
  | 'invalidResponse'
  | 'bindingExpired'

export type EnterpriseConnection = {
  origin: string | null
  state: 'disconnected' | 'connected' | 'unavailable' | 'revoked'
  officeHttpOrigin?: string
  bootstrap?: EnterpriseBootstrap
  issue?: EnterpriseIssue
}

export type EnterpriseEnrollment = { origin: string; challenge?: string; officeHttp?: boolean }

export type DesktopEnterpriseHost = {
  enroll(input: EnterpriseEnrollment): Promise<EnterpriseConnection>
  sync(incremental?: boolean): Promise<EnterpriseConnection>
  disconnect(): Promise<EnterpriseConnection>
  models(): Promise<EnterpriseModelCatalog | null>
  demand: EnterpriseDemandHost
  demandLocal?: EnterpriseDemandLocalHost
  memory?: EnterpriseMemoryHost
  memoryLocal?: EnterpriseMemoryLocalHost
  delivery?: EnterpriseDeliveryHost
}

