import { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { z } from 'zod';
import { hasAnyRole, MODULES, type RoleCode } from '@episoft/shared';
import { ApiError } from './lib/api';
import { meQuery } from './lib/auth';
import { LoginPage } from './routes/login';
import { ForgotPasswordPage, SetPasswordPage } from './routes/password';
import { AppShell } from './routes/shell';
import { HomePage } from './routes/home';
import { ModulePlaceholder } from './routes/module-placeholder';
import { AdminLayout } from './routes/admin/layout';
import { SettingsPage } from './routes/admin/settings';
import { UsersPage } from './routes/admin/users';
import { AuditPage } from './routes/admin/audit';
import { LoginsPage } from './routes/admin/logins';
import { NotFound, RouteError } from './routes/errors';
import { MembersPage } from './routes/members/list';
import { EditMemberPage, NewMemberPage } from './routes/members/member-form';
import { HouseholdPage } from './routes/members/household';
import { ProductsPage } from './routes/catalog/list';
import { EditProductPage, NewProductPage } from './routes/catalog/product-form';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) =>
        !(err instanceof ApiError && err.status > 0 && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
});

// --- Public pages ------------------------------------------------------------

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connexion',
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(meQuery)) throw redirect({ to: '/' });
  },
  component: LoginPage,
});

const forgotRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mot-de-passe-oublie',
  component: ForgotPasswordPage,
});

const setPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mot-de-passe',
  validateSearch: z.object({ jeton: z.string().optional() }),
  component: SetPasswordPage,
});

// --- Authenticated application -----------------------------------------------

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: '/connexion', search: { redirect: location.href } });
    return { me };
  },
  component: AppShell,
});

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: HomePage });

/** Client-side guard: comfort only, the API checks every call (R-AUTH-06). */
function requireRoles(roles: readonly RoleCode[]) {
  return ({ context }: { context: { me: { roles: RoleCode[] } } }) => {
    if (!hasAnyRole(context.me.roles, roles)) throw redirect({ to: '/' });
  };
}

/** Modules built so far; the others show what is coming (spec §10). */
const BUILT = new Set(['admin', 'membres', 'catalogue']);

const moduleRoutes = MODULES.filter((m) => !BUILT.has(m.key)).map((m) =>
  createRoute({
    getParentRoute: () => appRoute,
    path: m.path,
    beforeLoad: requireRoles(m.roles),
    component: () => <ModulePlaceholder moduleKey={m.key} />,
  }),
);

// --- Members (§4.2, §4.3) ---
const adherents = requireRoles(['ADHERENTS']);
const membersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/membres',
  beforeLoad: adherents,
  component: MembersPage,
});
const newMemberRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/membres/nouveau',
  beforeLoad: adherents,
  component: NewMemberPage,
});
const memberRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/membres/$id',
  beforeLoad: adherents,
  component: EditMemberPage,
});
const householdRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/foyers/$id',
  beforeLoad: adherents,
  component: HouseholdPage,
});

// --- Catalogue (§4.6) ---
const catalogReaders = requireRoles(['PRODUITS', 'APPROS']);
const productsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/catalogue',
  beforeLoad: catalogReaders,
  component: ProductsPage,
});
const newProductRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/catalogue/nouveau',
  beforeLoad: requireRoles(['PRODUITS']),
  component: NewProductPage,
});
const productRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/catalogue/$id',
  beforeLoad: catalogReaders,
  component: EditProductPage,
});

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin',
  beforeLoad: requireRoles(['ADMIN']),
  component: AdminLayout,
});
const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/admin/parametres' });
  },
});
const adminSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/parametres',
  component: SettingsPage,
});
const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/utilisateurs',
  component: UsersPage,
});
const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/journal',
  component: AuditPage,
});
const adminLoginsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/connexions',
  component: LoginsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  forgotRoute,
  setPasswordRoute,
  appRoute.addChildren([
    homeRoute,
    ...moduleRoutes,
    membersRoute,
    newMemberRoute,
    memberRoute,
    householdRoute,
    productsRoute,
    newProductRoute,
    productRoute,
    adminRoute.addChildren([
      adminIndexRoute,
      adminSettingsRoute,
      adminUsersRoute,
      adminAuditRoute,
      adminLoginsRoute,
    ]),
  ]),
]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
