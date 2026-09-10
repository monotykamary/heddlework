import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { BunPlugin } from 'bun'

export function webAliasPlugin(root: string): BunPlugin {
  const dom = (file: string) => resolve(root, 'src/dom', file)
  const gpuix = realpathSync(resolve(root, 'node_modules/@gpuix/react'))
  const exact: Record<string, string> = { '@gpuix/react': dom('host.tsx'), '@gpuix/react/jsx-runtime': dom('host.tsx'), '@gpuix/react/jsx-dev-runtime': dom('host.tsx'), 'node:path': dom('shims/node-path.ts'), path: dom('shims/node-path.ts') }
  const files: Record<string, string> = {
    'src/ui/clipboard-media.ts': dom('shims/clipboard-media.ts'),
    'src/ui/open-external.ts': dom('shims/open-external.ts'),
    'src/ui/theme-manager.ts': dom('shims/theme-manager.ts'),
  }
  const replacements = new Map(Object.entries(files).map(([file, target]) => [resolve(root, file), target]))
  return { name: 'heddlework-web-aliases', setup(build) {
    build.onResolve({ filter: /^(@gpuix\/react(\/jsx(-dev)?-runtime)?|node:path|path)$/u }, (args) => ({ path: exact[args.path]! }))
    build.onResolve({ filter: /^@gpuix\/react\/(select|combobox|tooltip)$/u }, (args) => ({ path: resolve(root, 'node_modules/@gpuix/react/dist/components', `${args.path.slice('@gpuix/react/'.length)}.js`) }))
    build.onResolve({ filter: /use-gpuix\.js$/u }, (args) => {
      const resolved = resolve(args.importer, '..', args.path)
      return resolved === resolve(gpuix, 'dist/hooks/use-gpuix.js')
        || resolved === resolve(root, 'node_modules/@gpuix/react/dist/hooks/use-gpuix.js')
        ? { path: dom('host.tsx') } : undefined
    })
    build.onResolve({ filter: /^react$/u }, (args) => {
      // A source-linked GPUix package may live outside node_modules. Only our
      // application modules need intrinsic remapping; dependencies use real React.
      const application = args.importer.startsWith(resolve(root, 'src') + sep)
      const host = args.importer.startsWith(resolve(root, 'src/dom') + sep)
      return application && !host ? { path: dom('react-shim.ts') } : undefined
    })
    build.onResolve({ filter: /\.(ts|tsx)$/u }, (args) => {
      if (args.path.startsWith('@gpuix/') || args.importer.startsWith(resolve(root, 'src/dom/shims'))) return undefined
      const absolute = args.path.startsWith('.') ? resolve(args.importer, '..', args.path) : args.path
      const replacement = replacements.get(absolute)
      return replacement ? { path: replacement } : undefined
    })
  } }
}
