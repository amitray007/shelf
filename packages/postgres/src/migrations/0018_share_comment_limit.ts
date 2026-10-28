import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const shareCommentLimitMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table shelf_shares
        add column comment_post_count integer not null default 0,
        add constraint shelf_shares_comment_post_count check (comment_post_count between 0 and 100)
    `.execute(database);
    // Preserve existing comments. Shares already at or above the limit cannot accept more.
    await sql`
      update shelf_shares as shares
      set comment_post_count = least(100, totals.post_count)::integer
      from (
        select threads.share_id, count(*) as post_count
        from shelf_comment_threads as threads
        join shelf_comment_posts as posts
          on posts.installation_id = threads.installation_id
          and posts.workspace_id = threads.workspace_id
          and posts.thread_id = threads.thread_id
        group by threads.share_id
      ) as totals
      where shares.share_id = totals.share_id
    `.execute(database);
  },
  async down(database: Kysely<unknown>): Promise<void> {
    await sql`alter table shelf_shares drop column comment_post_count`.execute(database);
  },
};
