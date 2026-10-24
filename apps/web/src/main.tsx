import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { queryClient, router } from './router';
import { ConfirmProvider } from '@/components/confirm';
import { registerSW } from 'virtual:pwa-register';
import './index.css';

// R-OFF-01: the service worker caches the application for offline use (production builds).
registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <RouterProvider router={router} />
      </ConfirmProvider>
    </QueryClientProvider>
  </StrictMode>,
);
