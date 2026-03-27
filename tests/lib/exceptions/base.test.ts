import { describe, it, expect } from 'vitest';

import { Sc0redError, registerError } from '../../../src/lib/exceptions/base';
import { ValidationError, NotFoundError } from '../../../src/lib/exceptions/client-errors';

describe('Sc0redError', () => {
  it('should look up error by code', () => {
    const ErrorClass = Sc0redError.getByErrorCode('VALIDATION_ERROR');
    expect(ErrorClass).toBeDefined();
  });

  it('should serialize to dict', () => {
    const error = new ValidationError('Bad input', { field: 'email' });
    const dict = error.toDict();
    expect(dict.errorCode).toBe('VALIDATION_ERROR');
    expect(dict.message).toBe('Bad input');
    expect(dict.context).toEqual({ field: 'email' });
  });

  it('should include context in toString', () => {
    const error = new NotFoundError('Not found', { resourceType: 'User' });
    expect(error.toString()).toContain('context');
  });
});
