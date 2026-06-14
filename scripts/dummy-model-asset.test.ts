import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModel, type Manifest } from '../src/ml/blob'
import { runReference } from '../src/ml/model'
import { outputToQuad } from '../src/recognize/KernelCornerSource'

// Validate the COMMITTED dummy asset end-to-end — the one the live app actually
// ships and the byte-gate measures. Regenerate with `npm run gen:dummy`.
const DIR = join(process.cwd(), 'public', 'models')
const manifest = JSON.parse(readFileSync(join(DIR, 'corner-dummy-v1.json'), 'utf8')) as Manifest
const blob = new Uint8Array(readFileSync(join(DIR, 'corner-dummy-v1.bin')))

describe('the shipped corner-dummy-v1 asset', () => {
  it('loads and reproduces its reference vector (trainer↔runtime parity on the real blob)', () => {
    const model = loadModel(manifest, blob)
    const { maxAbsError } = runReference(model)
    expect(maxAbsError).toBeLessThan(1e-4)
  })

  it('is the corner contract: 1×128×128 in, 8 corner coords out', () => {
    expect(manifest.input).toMatchObject({ channels: 1, height: 128, width: 128 })
    expect(manifest.output.size).toBe(8)
  })

  it('abstains by construction — its output is a degenerate quad (→ raw decode)', () => {
    const model = loadModel(manifest, blob)
    expect(outputToQuad(runReference(model).output, 320, 240)).toBeNull()
  })

  it('is within the per-model byte allowance (~1.5 MB)', () => {
    expect(blob.length).toBeLessThan(1.6 * 1024 * 1024)
    expect(blob.length).toBeGreaterThan(1.4 * 1024 * 1024)
  })
})
