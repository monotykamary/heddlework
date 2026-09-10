export function webPrecachePaths(filenames: readonly string[]): string[] {
  return filenames.filter((name) => name !== 'sw.js' && !name.endsWith('.map')).toSorted().map((name) => '/' + name)
}
