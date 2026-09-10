export interface GpuixSourcePin {
  gpuixRepository: string
  gpuixRevision: string
  zedRepository: string
  zedRevision: string
}

export function parseGpuixSourcePin(value: unknown): GpuixSourcePin {
  if (!value || typeof value !== 'object') throw new Error('Invalid GPUix source pin')
  const pin = value as Record<string, unknown>
  for (const field of ['gpuixRevision', 'zedRevision']) {
    if (typeof pin[field] !== 'string' || !/^[a-f0-9]{40}$/u.test(pin[field])) throw new Error(`Invalid ${field}: expected a full Git revision`)
  }
  for (const field of ['gpuixRepository', 'zedRepository']) {
    if (typeof pin[field] !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/u.test(pin[field])) throw new Error(`Invalid ${field}: expected a GitHub HTTPS repository`)
  }
  return pin as unknown as GpuixSourcePin
}

export function nativeBuildCommand(platform: string, withoutCef: boolean): string[] {
  if (platform === 'darwin' && !withoutCef) return ['bun', 'run', 'build:browser']
  if (platform === 'linux') return ['bun', 'run', 'build:release']
  return ['bun', 'run', 'build']
}
