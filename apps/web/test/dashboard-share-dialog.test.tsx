import { describe, expect, it } from 'vitest';

import {
  PRIVATE_COMMENT_POLICY_DESCRIPTION,
  SHARED_COMMENT_POLICY_DESCRIPTION,
} from '../src/dashboard/share-dialog.js';

describe('custom share dialog comments policy', () => {
  it('explains Private and Shared semantics without implying cross-link sharing', () => {
    expect(PRIVATE_COMMENT_POLICY_DESCRIPTION).toBe(
      'Visitors see only discussions they started; admins can see all.',
    );
    expect(SHARED_COMMENT_POLICY_DESCRIPTION).toBe(
      'Everyone using this link can see shared discussions.',
    );
    expect(SHARED_COMMENT_POLICY_DESCRIPTION).not.toContain('across shared links');
  });
});
