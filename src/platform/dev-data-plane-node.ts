/**
 * dev-data-plane-node — a NODE host for the build-side `/api/data/*` plane.
 *
 * The third host of one runtime. `pglite-substrate.ts` authors the data plane as source STRINGS
 * spliced into the preview Service Worker; `dev-handler-runtime.ts` already proves those bytes
 * instantiate in Node (`loadDevRuntime`, for the parity tests). This module does the same for the
 * REST surface, so `trivial dev` can serve a maker's own `/api/data/*` on their laptop **from the
 * bytes the workshop runs**, not from a second implementation of them.
 *
 *   workshop preview   SW          ← DEV_DATA_CORE_SOURCE + DATA_API_DISPATCH_SOURCE
 *   parity tests       node        ← the same strings (loadDevRuntime)
 *   `trivial dev`      node        ← the same strings (HERE)
 *
 * Why this matters more than convenience: RLS scoping, the `app_user` role wall, the identity GUCs,
 * the per-field read projection and the error→status mapping are all *decisions*, and a second copy
 * of a decision is a divergence waiting to happen. The routing is reused too — the cross-project
 * wall, the run-wire 404 shapes, the "PATCH without an id is unrouted, not a 400" details are the
 * kind of thing a reimplementation gets subtly wrong.
 *
 * WHAT THE HOST MUST SUPPLY (the five free variables the SW gets from its own scope):
 *   - `__pgliteGetDb()`      → a booted PGLite handle. The caller owns boot + schema; this module
 *                              never imports PGLite, exactly as the SW splice never does.
 *   - `getManifest()`        → `{ projectId }`, the frame's own identity. Feeds the CROSS-PROJECT
 *                              WALL: a request for any other projectId gets the run wire's
 *                              `404 table not found`, never another project's data.
 *   - `__pgliteViewAs`       → the identity wire (`trivial dev --as alice`), same shape and the
 *                              same precedence as the canvas picker: an explicit
 *                              `x-trivial-as-user` header still wins, per-request.
 *   - `__pgliteTableAccess`→ shimmed to 'unrestricted'. It feeds ONLY the preview-remedy
 *                              teaching wire, which posts to window clients — a workshop
 *                              affordance with no meaning in a terminal. `__emitPreviewRemedy` is
 *                              a no-op here, so the shim can never change a data response.
 *   - `self`                 → `location.origin` (the candidate test) + a `clients.matchAll` that
 *                              resolves empty.
 *
 * IDENTITY IS LOCAL FICTION, exactly as in the workshop: a Local user is an invented `sub`, not an
 * account, and `userId: null` scopes as anonymous — there is no sees-all mode on this plane, which
 * is what makes `--as alice` provable rather than decorative.
 */
import { DEV_DATA_CORE_SOURCE } from './dev-handler-runtime.js';
import { DATA_API_DISPATCH_SOURCE, DATA_CANDIDATE_SOURCE } from './pglite-substrate.js';

export interface DevIdentity {
  /** The invented Local user's id. `null`/`''` ⇒ anonymous (RLS public-only). */
  userId: string | null;
  /** A declared role from the manifest, when previewing as one. */
  role: string | null;
}

export interface DevDataPlaneOpts {
  /** A booted PGLite handle with the project's compiled schema already applied. */
  db: unknown;
  /** The project this plane serves — the cross-project wall compares against it. */
  projectId: string;
  /** The dev server's own origin, e.g. `http://127.0.0.1:5173`. */
  origin: string;
  /** Starting identity; default anonymous. */
  identity?: DevIdentity;
}

export interface DevDataPlane {
  /** Answer one `/api/data/...` request. Returns the same statuses/bodies the published wire does. */
  dispatch(request: Request, url: URL): Promise<Response>;
  /** True when this URL belongs to the data plane (origin + `/api/data/` prefix). */
  isCandidate(url: URL): boolean;
  /** Swap the ambient Draft identity (`--as`), between requests. */
  setIdentity(identity: DevIdentity): void;
}

/**
 * Instantiate the data plane for a Node host. Pure with respect to the sources — it never mutates
 * them, so the SW keeps splicing the identical bytes.
 */
export function loadDevDataPlane(opts: DevDataPlaneOpts): DevDataPlane {
  const prelude = `
    var __hostDb = __opts.db;
    var __hostProjectId = __opts.projectId;
    var __hostIdentity = __opts.identity;
    // The SW-scope externals the spliced sources close over. Declared BEFORE the splices so the
    // free variables in them resolve here instead of throwing.
    var self = { location: { origin: __opts.origin }, clients: { matchAll: function () { return Promise.resolve([]); } } };
    var __pgliteViewAs = __hostIdentity;
    function __pgliteGetDb() { return Promise.resolve(__hostDb); }
    function getManifest() { return Promise.resolve({ projectId: __hostProjectId }); }
    // Teaching-wire only (see the header) — never consulted on a data response.
    function __pgliteTableAccess() { return Promise.resolve('unrestricted'); }
  `;
  const epilogue = `
    return {
      dispatch: function (request, url) { return __dataDispatch(request, url); },
      isCandidate: function (url) { return __dataIsCandidate(url); },
      setIdentity: function (i) { __pgliteViewAs = i; },
    };
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  // DATA_CANDIDATE_SOURCE carries __dataIsCandidate, split out in so the Service
  // Worker can keep the URL test without keeping a database. Every host that dispatches needs both.
  const factory = new Function('__opts', prelude + DATA_CANDIDATE_SOURCE + DEV_DATA_CORE_SOURCE + DATA_API_DISPATCH_SOURCE + epilogue);
  return factory({
    db: opts.db,
    projectId: opts.projectId,
    origin: opts.origin,
    identity: opts.identity ?? { userId: null, role: null },
  }) as DevDataPlane;
}
