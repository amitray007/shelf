import { describe, expect, it } from 'vitest';

import { ordinal, revisionLabel } from '../src/components/revision-label.js';

describe('revision labels', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [10, '10th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [111, '111th'],
  ])('formats revision %i as %s', (value, expected) => {
    expect(ordinal(value)).toBe(expected);
  });

  it('adds the consistent revision prefix', () => {
    expect(revisionLabel(3)).toBe('Revision: 3rd');
  });
});
