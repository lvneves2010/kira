import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'abertura',
    loadComponent: () => import('./abertura/abertura.page').then((m) => m.AberturaPage),
  },
  {
    path: 'home',
    loadComponent: () => import('./home/home.page').then((m) => m.HomePage),
  },
  {
    path: '',
    redirectTo: 'abertura',
    pathMatch: 'full',
  },
];
