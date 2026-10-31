import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'prometheus:isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * Applied globally at `AuthGuard` level in Module 02; declared here now so the
 * guard has a stable contract to check from day one rather than being retrofitted
 * across every route later.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);