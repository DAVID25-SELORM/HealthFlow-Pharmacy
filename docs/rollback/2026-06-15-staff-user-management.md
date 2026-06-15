# Staff User Management Rollback

This change adds full staff editing and the `users.can_manage_purchases` permission.

## Application rollback

1. Revert the release commit that introduced staff editing and Purchases permissions.
2. Rebuild and redeploy the web app and local branch-server bundle.
3. Redeploy the previous `staff-admin` Edge Function.

## Database rollback

Keep `can_manage_purchases` during an application-only rollback. The previous app ignores the
column, so retaining it preserves assigned permissions and avoids data loss.

Only remove the column after every frontend and Edge Function has been rolled back:

```sql
alter table public.users drop column if exists can_manage_purchases;
```

Before removing it, restore the previous role-based Purchases access model. The migration
backfills users in the previously allowed roles, so rolling the application back without dropping
the column is the safest recovery path.
