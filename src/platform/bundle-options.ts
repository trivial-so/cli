/**
 * The esbuild options that make a workerd-runnable handler module — the CONTRACT, with no esbuild
 * value import so any host can execute them with its own copy.
 *
 * Split out of `bundle.ts` for `trivial dev`. The CLI runs the maker's
 * handlers in real workerd on their laptop, and needs the identical bundle shape — but it must not
 * carry esbuild's native binary in its one-file download, so it loads esbuild lazily from
 * `~/.trivial/runtime` and feeds it these options. Keeping the options here rather than copying
 * them means `platform: 'neutral'`, the `worker` condition, the `node:*` external and the
 * `virtual:handler` alias stay ONE definition. Those are not stylistic — they are what makes the
 * output loadable by workerd and what keeps a handler from resolving a Node build of a dependency.
 *
 * `import type` only: this module emits no require, which is the whole point.
 */
import type * as esbuild from 'esbuild';
import { WORKER_ENTRY_SOURCE } from './worker-entry.js';

export interface BuildHandlerBundleOptions {
  /** Absolute path to the user's handler module (exports `buildApp(ctx)`). */
  handlerFile: string;
  /** Absolute output path for the bundled workerd module (`worker.<bundle>.js`). */
  outFile: string;
  /** Dir from which the shim's bare imports (`hono`, …) resolve. */
  resolveDir: string;
  /** Extra node_modules roots (prod: the /deps split — node_modules does NOT live under sourceDir). */
  nodePaths?: string[];
}

/** The build options for one handler bundle. Pure. */
export function handlerBundleOptions(opts: BuildHandlerBundleOptions): esbuild.BuildOptions {
  return {
    stdin: {
      contents: WORKER_ENTRY_SOURCE,
      resolveDir: opts.resolveDir,
      loader: 'js',
      sourcefile: './worker-entry.js',
    },
    ...(opts.nodePaths?.length ? { nodePaths: opts.nodePaths } : {}),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['worker', 'browser'],
    external: ['node:*'],
    alias: { 'virtual:handler': opts.handlerFile },
    outfile: opts.outFile,
    logLevel: 'silent',
  };
}
