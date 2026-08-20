import { type Kysely, sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const actorDisplayNamesMigration: Migration = {
  async up(database: Kysely<unknown>): Promise<void> {
    await sql`
      alter table shelf_comment_posts
        drop constraint shelf_comment_posts_author
    `.execute(database);
    await sql`
      alter table shelf_comment_posts
        add constraint shelf_comment_posts_author check (
          (author_kind = 'visitor' and visitor_key is not null and actor_id is null and display_name is not null)
          or (
            author_kind = 'actor'
            and visitor_key is null
            and actor_id is not null
            and (display_name is null or char_length(display_name) between 1 and 128)
          )
        )
    `.execute(database);
  },

  async down(database: Kysely<unknown>): Promise<void> {
    await sql`update shelf_comment_posts set display_name = null where author_kind = 'actor'`.execute(
      database,
    );
    await sql`
      alter table shelf_comment_posts
        drop constraint shelf_comment_posts_author
    `.execute(database);
    await sql`
      alter table shelf_comment_posts
        add constraint shelf_comment_posts_author check (
          (author_kind = 'visitor' and visitor_key is not null and actor_id is null and display_name is not null)
          or (author_kind = 'actor' and visitor_key is null and actor_id is not null and display_name is null)
        )
    `.execute(database);
  },
};
