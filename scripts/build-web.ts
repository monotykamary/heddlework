import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { webBuildHash } from './web-build-hash.ts'
import { webAliasPlugin } from './web-aliases.ts'
import { webPrecachePaths } from '../src/web/sw-manifest.ts'
const root = resolve(import.meta.dir, '..')
const outdir = resolve(root, 'dist', 'web')
rmSync(outdir, { recursive: true, force: true }); mkdirSync(outdir, { recursive: true })
const common = { target: 'browser' as const, minify: true, format: 'esm' as const }
const result = await Bun.build({ ...common, entrypoints: [resolve(root, 'src/web/main.tsx')], outdir, naming: 'main.js', sourcemap: 'linked', tsconfig: resolve(root, 'src/web/tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"', 'process.platform': '__hwPlatform', 'process.env.HEDDLEWORK_REDUCED_MOTION': 'undefined' }, plugins: [webAliasPlugin(root)], jsx: { runtime: 'automatic', importSource: '@gpuix/react' } })
if (!result.success) { for (const log of result.logs) console.error(log); throw new Error('Failed to build the web workspace client') }
for (const file of ['index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg']) copyFileSync(resolve(root, 'src/web', file), resolve(outdir, file))
const assets = readdirSync(outdir)
const hash = webBuildHash(outdir, assets)
const worker = await Bun.build({ ...common, entrypoints: [resolve(root, 'src/web/sw.ts')], outdir, naming: 'sw.js', define: { __HEDDLEWORK_BUILD_HASH__: JSON.stringify(hash), __HEDDLEWORK_PRECACHE__: JSON.stringify(webPrecachePaths(assets)) } })
if (!worker.success) { for (const log of worker.logs) console.error(log); throw new Error('Failed to build the web service worker') }
console.log(`Built ${outdir}`)
