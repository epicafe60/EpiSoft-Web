import type { Page } from '@playwright/test';
import type { RoleCode } from '@episoft/shared';

export interface TestUser {
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  roles: RoleCode[];
}

export const USERS = {
  admin: {
    username: 'Alice_ADMIN',
    password: 'mot de passe admin',
    firstName: 'Alice',
    lastName: 'ADMIN',
    roles: ['ADMIN', 'CAISSE', 'ADHERENTS', 'PRODUITS', 'APPROS'],
  },
  cashier: {
    username: 'Carl_CAISSE',
    password: 'mot de passe caisse',
    firstName: 'Carl',
    lastName: 'CAISSE',
    roles: ['CAISSE'],
  },
} satisfies Record<string, TestUser>;

export async function login(page: Page, user: TestUser) {
  await page.goto('/connexion');
  await page.getByLabel('Identifiant').fill(user.username);
  await page.getByLabel('Mot de passe').fill(user.password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByRole('heading', { name: `Bonjour ${user.firstName}` }).waitFor();
}
