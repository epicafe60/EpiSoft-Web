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
import { MembershipTypesPage, TillAdminPage } from './routes/admin/till';
import { NotFound, RouteError } from './routes/errors';
import { MembersPage } from './routes/members/list';
import { EditMemberPage, NewMemberPage } from './routes/members/member-form';
import { HouseholdPage } from './routes/members/household';
import { ProductsPage } from './routes/catalog/list';
import { EditProductPage, NewProductPage } from './routes/catalog/product-form';
import { SuppliesLayout } from './routes/supplies/layout';
import { OrderPage, OrdersPage } from './routes/supplies/orders';
import { NewSupplierPage, SupplierPage, SuppliersPage } from './routes/supplies/suppliers';
import { InvoicePage, InvoicesPage, NewInvoicePage } from './routes/supplies/invoices';
import { StockPage } from './routes/supplies/stock';
import { InventoriesPage, InventoryPage } from './routes/supplies/inventories';
import { BulkPricesPage, LabelsPage, ShelvesPage } from './routes/catalog/tools';
import { AccountingLayout } from './routes/compta/layout';
import { EditEntryPage, EntriesPage, NewEntryPage } from './routes/compta/entries';
import { BankPage, StatementPage } from './routes/compta/bank';
import { PlanPage } from './routes/compta/plan';
import { ReportsPage } from './routes/compta/reports';
import { ClosingPage as YearClosingPage } from './routes/compta/closing';
import { TillLayout } from './till/layout';
import { TillGate } from './till/gate';
import { SalePage } from './till/sale';
import { TicketsPage } from './till/tickets';
import { ClosingPage } from './till/closing';

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
const BUILT = new Set(['admin', 'membres', 'catalogue', 'caisse', 'appros', 'compta']);

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

const productsLabelsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/catalogue/etiquettes',
  beforeLoad: requireRoles(['PRODUITS']),
  component: LabelsPage,
});
const productsPricesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/catalogue/prix',
  beforeLoad: requireRoles(['PRODUITS']),
  component: BulkPricesPage,
});
const productsShelvesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/catalogue/rayons',
  beforeLoad: requireRoles(['PRODUITS']),
  component: ShelvesPage,
});

// --- Supplies (§4.7–§4.10) ---
const suppliesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/appros',
  beforeLoad: requireRoles(['APPROS']),
  component: SuppliesLayout,
});
const suppliesIndexRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/appros/commandes' });
  },
});
const ordersRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/commandes',
  component: OrdersPage,
});
const orderRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/commandes/$id',
  component: OrderPage,
});
const suppliersRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/fournisseurs',
  component: SuppliersPage,
});
const newSupplierRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/fournisseurs/nouveau',
  component: NewSupplierPage,
});
const supplierRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/fournisseurs/$id',
  component: SupplierPage,
});
const invoicesRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/factures',
  component: InvoicesPage,
});
const newInvoiceRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/factures/nouvelle',
  component: NewInvoicePage,
});
const invoiceRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/factures/$id',
  component: InvoicePage,
});
const stockRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/stock',
  component: StockPage,
});
const inventoriesRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/inventaires',
  component: InventoriesPage,
});
const inventoryRoute = createRoute({
  getParentRoute: () => suppliesRoute,
  path: '/inventaires/$id',
  component: InventoryPage,
});

// --- Accounting (§4.11) ---
const accountingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/compta',
  beforeLoad: requireRoles(['COMPTA']),
  component: AccountingLayout,
});
const accountingIndexRoute = createRoute({
  getParentRoute: () => accountingRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/compta/ecritures' });
  },
});
const entriesRoute = createRoute({
  getParentRoute: () => accountingRoute,
  path: '/ecritures',
  component: EntriesPage,
});
const newEntryRoute = createRoute({
  getParentRoute: () => accountingRoute,
  path: '/ecritures/nouvelle',
  component: NewEntryPage,
});
const entryRoute = createRoute({
  getParentRoute: () => accountingRoute,
  path: '/ecritures/$id',
  component: EditEntryPage,
});
const bankRoute = createRoute({
  getParentRoute: () => accountingRoute,
  path: '/banque',
  component: BankPage,
});
const statementRoute = createRoute({
  getParentRoute: () => accountingRoute,
  path: '/banque/$id',
  component: StatementPage,
});
const reportsRoute = createRoute({
  getParentRoute: () => accountingRoute,
  path: '/editions',
  component: ReportsPage,
});
const planRoute = createRoute({
  getParentRoute: () => accountingRoute,
  path: '/plan',
  component: PlanPage,
});
const yearClosingRoute = createRoute({
  getParentRoute: () => accountingRoute,
  path: '/cloture',
  component: YearClosingPage,
});

// --- Till (§4.4, §4.5, §5.3): full screen, usable offline ---
const tillRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/caisse',
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: '/connexion', search: { redirect: location.href } });
    if (!hasAnyRole(me.roles, ['CAISSE'])) throw redirect({ to: '/' });
    return { me };
  },
  component: TillLayout,
});
const saleRoute = createRoute({
  getParentRoute: () => tillRoute,
  path: '/',
  component: () => (
    <TillGate>
      <SalePage />
    </TillGate>
  ),
});
const ticketsRoute = createRoute({
  getParentRoute: () => tillRoute,
  path: '/tickets',
  component: () => (
    <TillGate>
      <TicketsPage />
    </TillGate>
  ),
});
const closingRoute = createRoute({
  getParentRoute: () => tillRoute,
  path: '/cloture',
  component: () => (
    // The page stays mounted after closing to show the report.
    <TillGate needSession={false}>
      <ClosingPage />
    </TillGate>
  ),
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

const adminTypesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/adhesions',
  component: MembershipTypesPage,
});
const adminTillRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/caisse',
  component: TillAdminPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  forgotRoute,
  setPasswordRoute,
  tillRoute.addChildren([saleRoute, ticketsRoute, closingRoute]),
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
    productsLabelsRoute,
    productsPricesRoute,
    productsShelvesRoute,
    suppliesRoute.addChildren([
      suppliesIndexRoute,
      ordersRoute,
      orderRoute,
      suppliersRoute,
      newSupplierRoute,
      supplierRoute,
      invoicesRoute,
      newInvoiceRoute,
      invoiceRoute,
      stockRoute,
      inventoriesRoute,
      inventoryRoute,
    ]),
    accountingRoute.addChildren([
      accountingIndexRoute,
      entriesRoute,
      newEntryRoute,
      entryRoute,
      bankRoute,
      statementRoute,
      reportsRoute,
      planRoute,
      yearClosingRoute,
    ]),
    adminRoute.addChildren([
      adminIndexRoute,
      adminSettingsRoute,
      adminUsersRoute,
      adminAuditRoute,
      adminLoginsRoute,
      adminTypesRoute,
      adminTillRoute,
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
