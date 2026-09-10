// process.platform for the web bundle follows the visitor's OS so shortcut hints and chrome insets match the machine.

declare global { var __hwPlatform: string }

const ua = typeof navigator === 'undefined' ? '' : `${navigator.platform} ${navigator.userAgent}`
globalThis.__hwPlatform = /Mac|iPhone|iPad|iPod/i.test(ua) ? 'darwin' : /Win/i.test(ua) ? 'win32' : 'linux'

export {}
