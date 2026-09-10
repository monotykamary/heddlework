import React from 'react'

export type IconName =
  | 'search'
  | 'squarePen'
  | 'folder'
  | 'folderPlus'
  | 'chevronDown'
  | 'chevronUp'
  | 'chevronLeft'
  | 'chevronRight'
  | 'settings'
  | 'plus'
  | 'box'
  | 'download'
  | 'terminal'
  | 'panel'
  | 'panelLeft'
  | 'panelLeftClose'
  | 'refresh'
  | 'check'
  | 'circle'
  | 'sparkles'
  | 'lock'
  | 'gitBranch'
  | 'eye'
  | 'wrench'
  | 'x'
  | 'eraser'
  | 'arrowUp'
  | 'stop'
  | 'bell'
  | 'clock'
  | 'list'
  | 'grip'
  | 'fileDiff'
  | 'copy'
  | 'undo'
  | 'globe'
  | 'files'
  | 'bot'
  | 'wrap'
  | 'maximize'
  | 'minimize'
  | 'panelBottom'
  | 'windowMinimize'
  | 'windowMaximize'
  | 'windowRestore'

const ICONS: Record<IconName, string> = {
  search: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><path fill="#000" d="M23.957 41.77a18.02 18.02 0 0 0 10.477-3.376l11.109 11.11a2.66 2.66 0 0 0 1.898.773c1.524 0 2.625-1.172 2.625-2.672c0-.703-.234-1.359-.75-1.874L38.277 34.668c2.32-3.047 3.703-6.82 3.703-10.922c0-9.914-8.109-18.023-18.023-18.023c-9.937 0-18.023 8.109-18.023 18.023S14.02 41.77 23.957 41.77m0-3.891c-7.758 0-14.133-6.398-14.133-14.133S16.2 9.613 23.957 9.613c7.734 0 14.133 6.399 14.133 14.133c0 7.735-6.399 14.133-14.133 14.133"/></svg>',
  squarePen: svg('<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>'),
  folder: svg('<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
  folderPlus: svg('<path d="M12 10v6m-3-3h6"/><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
  chevronDown: svg('<path d="m6 9 6 6 6-6"/>'),
  chevronUp: svg('<path d="m6 15 6-6 6 6"/>'),
  chevronLeft: svg('<path d="m15 18-6-6 6-6"/>'),
  chevronRight: svg('<path d="m9 18 6-6-6-6"/>'),
  settings: svg('<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  box: svg('<path d="m21 8-9 5-9-5 9-5Z"/><path d="m3 8 9 5 9-5v8l-9 5-9-5Z"/>'),
  download: svg('<path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 21h14"/>'),
  terminal: svg('<path d="m5 7 4 4-4 4m6 0h8"/><rect x="2.5" y="4" width="19" height="16" rx="2"/>'),
  panel: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>'),
  panelLeft: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>'),
  panelLeftClose: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m7 9-3 3 3 3"/>'),
  refresh: svg('<g transform="translate(0 -1)"><path d="M20 6v5h-5"/><path d="M19 11a7 7 0 1 0 1 5"/></g>'),
  check: svg('<path d="m5 12 4 4L19 6"/>'),
  circle: svg('<circle cx="12" cy="12" r="8"/>'),
  sparkles: svg('<path d="m12 3 1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2Z"/><path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8Z"/>'),
  lock: svg('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
  gitBranch: svg('<circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m2-8c5 0 8-1 8-3"/>'),
  eye: svg('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>'),
  wrench: svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-8 8l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 8-8Z"/>'),
  x: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  eraser: svg('<path d="m7 21-4-4a2.8 2.8 0 0 1 0-4L14 2a2.8 2.8 0 0 1 4 0l3 3a2.8 2.8 0 0 1 0 4L9 21Z"/><path d="m5 11 9 9M7 21h14"/>'),
  arrowUp: svg('<path d="M12 19V5m-6 6 6-6 6 6"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>'),
  bell: svg('<path d="M10.3 4.2a2 2 0 0 1 3.4 0A6 6 0 0 1 18 10v4l2 3H4l2-3v-4a6 6 0 0 1 4.3-5.8Z"/><path d="M10 21h4"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r=".5" fill="currentColor"/><circle cx="3.5" cy="12" r=".5" fill="currentColor"/><circle cx="3.5" cy="18" r=".5" fill="currentColor"/>'),
  grip: svg('<circle cx="9" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="5" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="19" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="19" r="1" fill="currentColor" stroke="none"/>'),
  fileDiff: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6m-3-3v6m-3 3h6"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"/>'),
  undo: svg('<path d="m9 14-5-5 5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v1"/>'),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>'),
  files: svg('<path d="M15 2H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z"/><path d="M9 22h9a2 2 0 0 0 2-2V7"/>'),
  bot: svg('<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8"/>'),
  wrap: svg('<path d="M4 7h11a4 4 0 0 1 0 8H9"/><path d="m12 12-3 3 3 3M4 12h5"/>'),
  maximize: svg('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>'),
  minimize: svg('<path d="M8 8H3V3M16 8h5V3M8 16H3v5M16 16h5v5"/>'),
  windowMinimize: svg('<path d="M5 16h14"/>'),
  windowMaximize: svg('<rect x="5" y="5" width="14" height="14" rx="1"/>'),
  windowRestore: svg('<path d="M9 5V3h12v12h-2"/><rect x="3" y="9" width="12" height="12" rx="1"/>'),
  panelBottom: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18"/>'),
}

const ICON_SOURCES = Object.fromEntries(
  Object.entries(ICONS).map(([name, source]) => [name, `data:image/svg+xml,${encodeURIComponent(source)}`]),
) as Record<IconName, string>

export function Icon({ name, size = 16, color = 'currentColor' }: { name: IconName; size?: number; color?: string }) {
  return React.createElement('svg', {
    src: ICON_SOURCES[name],
    style: { width: size, height: size, flexShrink: 0, color },
  } as never)
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}
