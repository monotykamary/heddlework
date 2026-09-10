// React re-export for the web bundle whose createElement maps gpuix intrinsic names onto the DOM host components.
// Everything else is the real React so hooks, context, and react-dom share one instance.

import * as ReactNS from 'react'
import { resolveIntrinsic } from './host.tsx'

const RealReact = ReactNS as unknown as typeof import('react')
const realCreateElement = RealReact.createElement

function createElement(type: unknown, props?: unknown, ...children: unknown[]) {
  return realCreateElement(resolveIntrinsic(type) as never, props as never, ...(children as never[]))
}

const patched = { ...RealReact, createElement, default: undefined as unknown } as unknown as typeof import('react') & { default: typeof import('react') }
patched.default = patched

export default patched
export const {
  Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense,
  cloneElement, createContext, createRef, forwardRef, isValidElement, lazy, memo, startTransition,
  useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect,
  useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, useTransition, act, use, version,
} = RealReact
export { createElement }
